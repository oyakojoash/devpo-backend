const mongoose = require('mongoose');
const Story = require('../models/Story');
const Merchant = require('../models/Merchant');
const Vendor = require('../models/Vendor');
const cloudinaryDefault = require('../config/cloudinary');

const DAY_MS = 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

function boundedEnvInteger(name, fallback, minimum, maximum) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

const mediaLimits = () => ({
  imageBytes: boundedEnvInteger('STORY_IMAGE_MAX_BYTES', 5 * 1024 * 1024, 1, 5 * 1024 * 1024),
  videoBytes: boundedEnvInteger('STORY_VIDEO_MAX_BYTES', 50 * 1024 * 1024, 1, 50 * 1024 * 1024),
  videoDurationSeconds: boundedEnvInteger('STORY_VIDEO_MAX_DURATION_SECONDS', 60, 1, 60),
});

function detectMedia(buffer, declaredMime) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (declaredMime === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image';
  if (declaredMime === 'image/png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image';
  if (declaredMime === 'image/gif' && buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image';
  if (declaredMime === 'image/webp' && buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image';
  if (declaredMime === 'video/mp4' && buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'video';
  if (declaredMime === 'video/webm' && buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video';
  return null;
}

function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 256) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.createdAt !== 'string' || !OBJECT_ID.test(decoded.id) || !Number.isFinite(Date.parse(decoded.createdAt))) return undefined;
    return { createdAt: new Date(decoded.createdAt), id: new mongoose.Types.ObjectId(decoded.id) };
  } catch { return undefined; }
}

function pageQuery(query) {
  const limitText = query.limit;
  if (limitText !== undefined && (typeof limitText !== 'string' || !/^\d+$/.test(limitText))) return null;
  const limit = limitText === undefined ? 20 : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return null;
  const cursor = parseCursor(query.cursor);
  if (cursor === undefined) return null;
  return { limit, cursor };
}

function encodeCursor(story) {
  return Buffer.from(JSON.stringify({ createdAt: story.createdAt.toISOString(), id: String(story._id) })).toString('base64url');
}

function serializeStory(story, merchant, { includeProfileImage = false } = {}) {
  return {
    id: String(story._id),
    merchantId: String(story.merchant),
    mediaType: story.mediaType,
    mediaUrl: story.mediaUrl,
    caption: story.caption || '',
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    viewsCount: story.viewsCount,
    ...(merchant ? { merchant: {
      id: String(merchant._id),
      name: merchant.name,
      ...(includeProfileImage ? { profileImage: merchant.profileImage ?? null } : {}),
    } } : {}),
  };
}

function cloudinaryUpload(cloudinary, buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}

function cloudinaryDestroy(cloudinary, publicId, resourceType) {
  return new Promise((resolve, reject) => cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true }, (error, result) => error ? reject(error) : resolve(result)));
}

function createStoryController({ StoryModel = Story, MerchantModel = Merchant, VendorModel = Vendor, cloudinary = cloudinaryDefault, now = () => new Date(), logger = console } = {}) {
  async function publish(req, res) {
    if (!req.file) return res.status(400).json({ success: false, message: 'Media file is required' });
    const mime = req.file.mimetype;
    const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const videoTypes = new Set(['video/mp4', 'video/webm']);
    const expectedType = imageTypes.has(mime) ? 'image' : videoTypes.has(mime) ? 'video' : null;
    const limits = mediaLimits();
    if (!expectedType) return res.status(400).json({ success: false, message: 'Unsupported media type' });
    const maxBytes = expectedType === 'image' ? limits.imageBytes : limits.videoBytes;
    if (req.file.size > maxBytes || req.file.buffer.length > maxBytes) return res.status(413).json({ success: false, message: 'Media exceeds the allowed size limit' });
    if (detectMedia(req.file.buffer, mime) !== expectedType) return res.status(400).json({ success: false, message: 'Media content does not match a supported format' });
    const caption = req.body?.caption === undefined ? '' : req.body.caption;
    if (typeof caption !== 'string' || caption.trim().length > 500) return res.status(400).json({ success: false, message: 'Caption must be 500 characters or fewer' });
    const merchantId = req.merchant?._id;
    if (!merchantId) return res.status(401).json({ success: false, message: 'Merchant not authenticated' });

    let uploaded;
    try {
      uploaded = await cloudinaryUpload(cloudinary, req.file.buffer, {
        folder: process.env.STORY_CLOUDINARY_FOLDER || 'dvepo_stories',
        resource_type: expectedType === 'video' ? 'video' : 'image',
        allowed_formats: expectedType === 'video' ? ['mp4', 'webm'] : ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        ...(expectedType === 'video' ? { eager_async: false } : {}),
      });
    } catch (error) {
      logger.warn('Story media upload failed:', error?.name || 'Error');
      return res.status(502).json({ success: false, message: 'Story media upload failed' });
    }
    const publicId = uploaded?.public_id;
    const resourceType = expectedType === 'video' ? 'video' : 'image';
    if (!publicId || !uploaded.secure_url || (expectedType === 'video' && (!Number.isFinite(uploaded.duration) || uploaded.duration > limits.videoDurationSeconds))) {
      if (publicId) {
        try { await cloudinaryDestroy(cloudinary, publicId, resourceType); }
        catch (error) { logger.error('Rejected story media cleanup failed:', error?.name || 'Error'); }
      }
      return res.status(400).json({ success: false, message: expectedType === 'video' ? `Video duration could not be verified or exceeds ${limits.videoDurationSeconds} seconds` : 'Cloudinary returned invalid media metadata' });
    }

    const createdAt = now();
    try {
      const story = await StoryModel.create({
        merchant: merchantId,
        mediaType: expectedType,
        mediaUrl: uploaded.secure_url,
        cloudinaryPublicId: publicId,
        caption: caption.trim(),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + DAY_MS),
        viewsCount: 0,
      });
      return res.status(201).json({ success: true, story: serializeStory(story) });
    } catch (error) {
      try { await cloudinaryDestroy(cloudinary, publicId, resourceType); }
      catch (cleanupError) { logger.error('Orphaned story media cleanup failed:', cleanupError?.name || 'Error'); }
      logger.error('Story creation failed:', error?.name || 'Error');
      return res.status(500).json({ success: false, message: 'Failed to create story' });
    }
  }

  async function listActive(req, res, merchantId = null) {
    const page = pageQuery(req.query);
    if (!page) return res.status(400).json({ success: false, message: 'Invalid pagination parameters' });
    const nowValue = now();
    const filter = { expiresAt: { $gt: nowValue }, ...(merchantId ? { merchant: merchantId } : {}) };
    if (page.cursor) filter.$or = [
      { createdAt: { $lt: page.cursor.createdAt } },
      { createdAt: page.cursor.createdAt, _id: { $lt: page.cursor.id } },
    ];
    const rows = await StoryModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(page.limit + 1).lean();
    const hasMore = rows.length > page.limit;
    const stories = rows.slice(0, page.limit);
    let merchantMap = new Map();
    if (stories.length) {
      const merchantIds = [...new Set(stories.map((story) => String(story.merchant)))];
      const [merchants, linkedVendors, publicVendors] = await Promise.all([
        MerchantModel.find({ _id: { $in: merchantIds } }).select('_id name').lean(),
        VendorModel.find({ merchantId: { $in: merchantIds } }).select('_id merchantId').lean(),
        VendorModel.find({ merchantId: { $in: merchantIds }, ...VendorModel.publicMarketplaceFilter() }).select('_id merchantId logo').lean(),
      ]);
      const linkedCounts = new Map();
      for (const vendor of linkedVendors) {
        const key = String(vendor.merchantId);
        linkedCounts.set(key, (linkedCounts.get(key) || 0) + 1);
      }
      const publicVendorByMerchant = new Map(publicVendors.map((vendor) => [String(vendor.merchantId), vendor]));
      merchantMap = new Map(merchants.map((merchant) => {
        const key = String(merchant._id);
        const solePublicVendor = linkedCounts.get(key) === 1 ? publicVendorByMerchant.get(key) : null;
        return [key, { ...merchant, profileImage: solePublicVendor?.logo ?? null }];
      }));
    }
    return res.json({ success: true, stories: stories.map((story) => serializeStory(story, merchantMap.get(String(story.merchant)), { includeProfileImage: true })), nextCursor: hasMore ? encodeCursor(stories.at(-1)) : null });
  }

  async function active(req, res) { return listActive(req, res); }
  async function merchantActive(req, res) {
    if (!OBJECT_ID.test(req.params.merchantId)) return res.status(400).json({ success: false, message: 'Invalid merchant ID' });
    return listActive(req, res, new mongoose.Types.ObjectId(req.params.merchantId));
  }
  async function mine(req, res) {
    const page = pageQuery(req.query);
    if (!page) return res.status(400).json({ success: false, message: 'Invalid pagination parameters' });
    const filter = { merchant: req.merchant._id };
    if (page.cursor) filter.$or = [
      { createdAt: { $lt: page.cursor.createdAt } },
      { createdAt: page.cursor.createdAt, _id: { $lt: page.cursor.id } },
    ];
    const rows = await StoryModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(page.limit + 1).lean();
    const hasMore = rows.length > page.limit;
    const stories = rows.slice(0, page.limit);
    return res.json({ success: true, stories: stories.map((story) => serializeStory(story)), nextCursor: hasMore ? encodeCursor(stories.at(-1)) : null });
  }
  async function view(req, res) {
    if (!OBJECT_ID.test(req.params.storyId)) return res.status(400).json({ success: false, message: 'Invalid story ID' });
    const story = await StoryModel.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(req.params.storyId), expiresAt: { $gt: now() } },
      { $inc: { viewsCount: 1 } },
      { new: true, projection: { viewsCount: 1 } },
    ).lean();
    if (!story) return res.status(404).json({ success: false, message: 'Active story not found' });
    return res.json({ success: true, viewsCount: story.viewsCount });
  }
  async function remove(req, res) {
    if (!OBJECT_ID.test(req.params.storyId)) return res.status(400).json({ success: false, message: 'Invalid story ID' });
    const story = await StoryModel.findOneAndDelete({ _id: new mongoose.Types.ObjectId(req.params.storyId), merchant: req.merchant._id }).lean();
    if (!story) return res.status(404).json({ success: false, message: 'Story not found' });
    try { await cloudinaryDestroy(cloudinary, story.cloudinaryPublicId, story.mediaType === 'video' ? 'video' : 'image'); }
    catch (error) { logger.error('Deleted story media cleanup failed:', error?.name || 'Error'); }
    return res.json({ success: true, message: 'Story deleted' });
  }

  return { publish, active, mine, merchantActive, view, remove };
}

module.exports = { createStoryController, detectMedia, mediaLimits, pageQuery, serializeStory };
