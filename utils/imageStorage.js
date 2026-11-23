const DEFAULT_CLOUDINARY_FOLDER = 'website_uploads';
const LEGACY_CLOUDINARY_FOLDER = 'website_seed';

function getCloudinaryFolders(configuredFolder) {
  const primaryFolder = typeof configuredFolder === 'string' && configuredFolder.trim()
    ? configuredFolder.trim()
    : DEFAULT_CLOUDINARY_FOLDER;
  return [...new Set([primaryFolder, LEGACY_CLOUDINARY_FOLDER])];
}

function buildCloudinaryImageUrl(cloudName, folder, filename) {
  const safeFolder = folder.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const safeFilename = encodeURIComponent(filename.trim().replace(/\.jpeg$/i, '.jpg'));
  return `https://res.cloudinary.com/${cloudName}/image/upload/${safeFolder}/${safeFilename}`;
}

async function fetchCloudinaryImage({ cloudName, folders, filename, fetchImage }) {
  for (const folder of folders) {
    try {
      const response = await fetchImage(buildCloudinaryImageUrl(cloudName, folder, filename), {
        responseType: 'stream',
        timeout: 10000,
      });
      return { response, folder };
    } catch (_error) {
      // Try only the next known folder, then let the caller use GridFS.
    }
  }
  return null;
}

function uploadGridFsBackup(bucket, filename, buffer, contentType, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let stream;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error('GridFS image backup timed out');
      fail(error);
      if (typeof stream?.destroy === 'function') stream.destroy(error);
    }, timeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    try {
      stream = bucket.openUploadStream(filename, { contentType });
      stream.once('error', fail);
      stream.once('finish', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(stream);
      });
      stream.end(buffer);
    } catch (error) {
      fail(error);
    }
  });
}

function getGridFsContentType(file) {
  const storedType = file?.contentType || file?.metadata?.contentType;
  if (storedType && storedType !== 'application/octet-stream') return storedType;
  const extension = String(file?.filename || '').split('.').pop().toLowerCase();
  const inferred = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }[extension];
  return inferred || storedType || 'application/octet-stream';
}

function getProductImageUrl(image, backendUrl = '') {
  if (typeof image !== 'string' || !image.trim()) return null;
  const value = image.trim();
  if (/^(?:https?:)?\/\//i.test(value)) return value;

  const base = backendUrl.replace(/\/+$/, '');
  const relativePath = value.replace(/^\/+/, '');
  // Keep explicit local paths (and paths produced by the old /images virtual)
  // working while bare uploaded filenames use the mounted image API route.
  if (value.startsWith('/')) {
    return `${base}/${relativePath}`;
  }
  if (relativePath.startsWith('images/') || relativePath.startsWith('api/images/')) {
    return `${base}/${relativePath}`;
  }
  if (relativePath.includes('/')) return `${base}/images/${relativePath}`;
  return `${base}/api/images/${encodeURIComponent(relativePath)}`;
}

module.exports = {
  DEFAULT_CLOUDINARY_FOLDER,
  LEGACY_CLOUDINARY_FOLDER,
  getCloudinaryFolders,
  buildCloudinaryImageUrl,
  fetchCloudinaryImage,
  uploadGridFsBackup,
  getGridFsContentType,
  getProductImageUrl,
};
