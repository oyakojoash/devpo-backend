const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const IMAGES_FOLDER = path.join(__dirname, "../public/images");

(async () => {
  try {
    const files = fs.readdirSync(IMAGES_FOLDER).filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f));
    for (const file of files) {
      const filePath = path.join(IMAGES_FOLDER, file);

      const result = await cloudinary.uploader.upload(filePath, {
        folder: 'website_seed',
        public_id: path.parse(file).name,
      });

      console.log('✅ Uploaded:', result.secure_url);
    }

    console.log('🎉 All images seeded to Cloudinary!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error seeding Cloudinary:', err);
    process.exit(1);
  }
})();
