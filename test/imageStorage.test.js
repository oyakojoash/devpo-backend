const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const axios = require('axios');
const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');
const Image = require('../models/Image');
const imageRouter = require('../routes/imageRoutes');
const { app } = require('../server');
const {
  getCloudinaryFolders,
  fetchCloudinaryImage,
  buildCloudinaryImageUrl,
  uploadGridFsBackup,
  getGridFsContentType,
  getProductImageUrl,
} = require('../utils/imageStorage');

test('uses website_uploads by default and preserves an explicit Cloudinary folder', () => {
  assert.deepEqual(getCloudinaryFolders(undefined), ['website_uploads', 'website_seed']);
  assert.deepEqual(getCloudinaryFolders('custom_assets'), ['custom_assets', 'website_seed']);
  assert.deepEqual(getCloudinaryFolders('website_seed'), ['website_seed']);
});

test('tries the legacy website_seed folder after the configured folder fails', async () => {
  const requested = [];
  const result = await fetchCloudinaryImage({
    cloudName: 'test-cloud',
    folders: getCloudinaryFolders(undefined),
    filename: 'image-1.jpg',
    async fetchImage(url) {
      requested.push(url);
      if (url.includes('/website_uploads/')) throw new Error('not found');
      return { data: 'image stream', headers: {} };
    },
  });

  assert.equal(requested.length, 2);
  assert.match(requested[0], /\/website_uploads\/image-1\.jpg$/);
  assert.match(requested[1], /\/website_seed\/image-1\.jpg$/);
  assert.equal(result.folder, 'website_seed');
});

test('GridFS backup resolves only after its upload stream finishes', async () => {
  class ControlledStream extends EventEmitter {
    id = 'gridfs-file-id';
    end(buffer) { this.buffer = buffer; }
  }
  const stream = new ControlledStream();
  const bucket = { openUploadStream: () => stream };
  const upload = uploadGridFsBackup(bucket, 'image.jpg', Buffer.from('image'), 'image/jpeg');
  let resolved = false;
  upload.then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);

  stream.emit('finish');
  assert.equal(await upload, stream);
  assert.equal(stream.buffer.toString(), 'image');
});

test('GridFS backup rejects on stream error and on a stalled stream timeout', async () => {
  class ControlledStream extends EventEmitter {
    destroy(error) { this.emit('error', error); }
    end() {}
  }
  const stream = new ControlledStream();
  const failedUpload = uploadGridFsBackup({ openUploadStream: () => stream }, 'image.jpg', Buffer.alloc(0), 'image/jpeg');
  stream.emit('error', new Error('write failed'));
  await assert.rejects(failedUpload, /write failed/);

  let destroyed = false;
  const stalledStream = new ControlledStream();
  stalledStream.destroy = () => { destroyed = true; };
  await assert.rejects(
    uploadGridFsBackup({ openUploadStream: () => stalledStream }, 'image.jpg', Buffer.alloc(0), 'image/jpeg', 5),
    /timed out/
  );
  assert.equal(destroyed, true);
});

test('product image URLs preserve direct and local paths and route bare filenames through the image API', () => {
  assert.equal(
    getProductImageUrl('https://res.cloudinary.com/example/image/upload/a.jpg', 'https://api.example/'),
    'https://res.cloudinary.com/example/image/upload/a.jpg'
  );
  assert.equal(getProductImageUrl('/images/legacy/a.jpg', 'https://api.example/'), 'https://api.example/images/legacy/a.jpg');
  assert.equal(getProductImageUrl('legacy/a.jpg', 'https://api.example/'), 'https://api.example/images/legacy/a.jpg');
  assert.equal(getProductImageUrl('images/legacy/a.jpg', 'https://api.example/'), 'https://api.example/images/legacy/a.jpg');
  assert.equal(getProductImageUrl('new image.jpg', 'https://api.example/'), 'https://api.example/api/images/new%20image.jpg');
  assert.equal(getProductImageUrl('', 'https://api.example'), null);
});

test('GridFS retrieval uses stored MIME metadata or infers legacy image types from filenames', () => {
  assert.equal(getGridFsContentType({ filename: 'legacy.jpg' }), 'image/jpeg');
  assert.equal(getGridFsContentType({ filename: 'legacy.jpeg', contentType: 'application/octet-stream' }), 'image/jpeg');
  assert.equal(getGridFsContentType({ filename: 'legacy.png', metadata: { contentType: 'image/png' } }), 'image/png');
  assert.equal(getGridFsContentType({ filename: 'unknown.bin' }), 'application/octet-stream');
});

test('encodes raw Cloudinary filenames exactly once', () => {
  const cases = [
    ['Beige sling bag.jpg', 'Beige%20sling%20bag.jpg'],
    ['HP (640)+100%.jpg', 'HP%20(640)%2B100%25.jpg'],
    ['café 日本語.jpg', 'caf%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E.jpg'],
  ];

  for (const [filename, expectedPathSegment] of cases) {
    const url = buildCloudinaryImageUrl('test-cloud', 'website_uploads', filename);
    assert.equal(url.split('/').at(-1), expectedPathSegment);
    assert.equal(url.includes('%2520'), false);
  }
});
test('image retrieval sends once-encoded decoded filenames to the provider', async () => {
  const route = imageRouter.stack.find(
    (layer) => layer.route?.path === '/:filename' && layer.route.methods.get,
  ).route.stack[0].handle;
  const cases = [
    ['Beige sling bag.jpg', 'Beige%20sling%20bag.jpg'],
    ['HP (640)+100%.jpg', 'HP%20(640)%2B100%25.jpg'],
    ['café 日本語.jpg', 'caf%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E.jpg'],
    ['legacy.jpeg', 'legacy.jpg'],
  ];
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalGet = axios.get;
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';

  try {
    for (const [filename, expectedPathSegment] of cases) {
      let requestedUrl;
      axios.get = async (url) => {
        requestedUrl = url;
        return {
          data: { pipe() {} },
          headers: { 'content-type': 'image/jpeg' },
        };
      };
      const responseHeaders = {};
      const response = {
        set(name, value) { responseHeaders[name] = value; return this; },
      };

      await route({ params: { filename } }, response);
      assert.equal(requestedUrl.split('/').at(-1), expectedPathSegment);
      assert.equal(requestedUrl.includes('%2520'), false);
      assert.equal(responseHeaders['Content-Type'], 'image/jpeg');
    }
  } finally {
    axios.get = originalGet;
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  }
});

test('legacy GridFS image responses infer an image MIME type when old files lack metadata', async () => {
  const route = imageRouter.stack.find(
    (layer) => layer.route?.path === '/:filename' && layer.route.methods.get,
  ).route.stack[0].handle;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalGet = axios.get;
  const originalDb = mongoose.connection.db;
  const originalDownload = mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName;
  const downloadStream = new EventEmitter();
  let pipedTo = null;
  downloadStream.pipe = (destination) => { pipedTo = destination; return destination; };
  process.env.CLOUDINARY_CLOUD_NAME = 'mock-cloud';
  axios.get = async () => { throw new Error('mock Cloudinary miss'); };
  mongoose.connection.db = {
    collection: () => ({
      find: () => ({ limit: () => ({ toArray: async () => [{ filename: 'legacy.jpg' }] }) }),
    }),
  };
  mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName = () => downloadStream;

  try {
    const headers = {};
    const response = { set(name, value) { headers[name] = value; return this; } };
    await route({ params: { filename: 'legacy.jpg' } }, response);
    assert.equal(headers['Content-Type'], 'image/jpeg');
    assert.equal(pipedTo, response);
  } finally {
    axios.get = originalGet;
    mongoose.connection.db = originalDb;
    mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName = originalDownload;
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  }
});

test('local image API serves a mocked legacy GridFS asset with its inferred MIME type', async () => {
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalGet = axios.get;
  const originalDb = mongoose.connection.db;
  const originalDownload = mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName;
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
  const downloadStream = new EventEmitter();
  downloadStream.pipe = (destination) => { destination.end(imageBytes); return destination; };
  process.env.CLOUDINARY_CLOUD_NAME = 'mock-cloud';
  axios.get = async () => { throw new Error('mock Cloudinary miss'); };
  mongoose.connection.db = {
    collection: () => ({
      find: () => ({ limit: () => ({ toArray: async () => [{ filename: 'legacy.jpg' }] }) }),
    }),
  };
  mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName = () => downloadStream;
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/images/legacy.jpg`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^image\/jpeg/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    axios.get = originalGet;
    mongoose.connection.db = originalDb;
    mongoose.mongo.GridFSBucket.prototype.openDownloadStreamByName = originalDownload;
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  }
});

test('a mocked new upload returns an API reference that retrieves the uploaded image bytes', async () => {
  const uploadRoute = imageRouter.stack.find(
    (layer) => layer.route?.path === '/upload' && layer.route.methods.post,
  ).route;
  const uploadHandler = uploadRoute.stack[2].handle;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const originalUploadStream = cloudinary.uploader.upload_stream;
  const originalGet = axios.get;
  const originalImageCreate = Image.create;
  const originalDb = mongoose.connection.db;
  const originalGridUpload = mongoose.mongo.GridFSBucket.prototype.openUploadStream;
  const localImagePath = require('node:path').join(__dirname, '../public/images/Beige sling bag.jpeg');
  const imageBytes = require('node:fs').readFileSync(localImagePath);
  let storedImage = null;
  let cloudinaryOptions = null;
  process.env.CLOUDINARY_CLOUD_NAME = 'mock-cloud';
  cloudinary.uploader.upload_stream = (options, callback) => {
    cloudinaryOptions = options;
    return new Writable({
      write(_chunk, _encoding, done) { done(); },
      final(done) {
        callback(null, {
          secure_url: 'https://res.cloudinary.com/mock-cloud/image/upload/mock.jpg',
          public_id: `${options.folder}/mock-upload.jpg`,
        });
        done();
      },
    });
  };
  axios.get = async () => ({
    data: Readable.from([imageBytes]),
    headers: { 'content-type': 'image/jpeg' },
  });
  Image.create = async (record) => { storedImage = record; };
  mongoose.connection.db = {};
  mongoose.mongo.GridFSBucket.prototype.openUploadStream = () => {
    throw new Error('mock GridFS backup unavailable');
  };
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  try {
    let uploadResponse;
    const response = {
      status(code) { this.statusCode = code; return this; },
      json(body) { uploadResponse = body; return this; },
    };
    await uploadHandler({
      file: { buffer: imageBytes, mimetype: 'image/jpeg' },
      merchant: { _id: '507f1f77bcf86cd799439011' },
      admin: null,
    }, response);
    assert.equal(response.statusCode, 201);
    assert.match(uploadResponse.reference, /^\/api\/images\/[0-9a-f-]+\.jpg$/i);
    assert.equal(storedImage.ownerType, 'merchant');
    assert.equal(storedImage.cloudinaryPublicId, cloudinaryOptions.folder + '/mock-upload.jpg');
    assert.equal(uploadResponse.backup.status, 'failed');

    const imageResponse = await fetch(
      `http://127.0.0.1:${server.address().port}${uploadResponse.reference}`,
    );
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type') || '', /^image\/jpeg/);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    cloudinary.uploader.upload_stream = originalUploadStream;
    axios.get = originalGet;
    Image.create = originalImageCreate;
    mongoose.connection.db = originalDb;
    mongoose.mongo.GridFSBucket.prototype.openUploadStream = originalGridUpload;
    if (originalCloudName === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  }
});

test('local backend serves several existing product images as actual JPEG bytes', async () => {
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const filenames = ['Beige sling bag.jpeg', 'Cute yellow bag.jpeg', 'HP Elitebook 840G3.jpeg'];
  try {
    for (const filename of filenames) {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/images/${encodeURIComponent(filename)}`,
      );
      assert.equal(response.status, 200, filename);
      assert.match(response.headers.get('content-type') || '', /^image\/jpeg/, filename);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], filename);
      assert.ok(bytes.length > 1000, filename);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('serves the existing fallback image for cross-origin frontend embedding', async () => {
  const server = await new Promise((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });

  try {
    const url = `http://127.0.0.1:${server.address().port}/images/fallback.jpeg`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^image\/jpeg$/);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
