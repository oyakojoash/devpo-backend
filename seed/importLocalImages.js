const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const Grid = require("gridfs-stream");
const Image = require("../models/Image");

const IMAGES_DIR = path.join(__dirname, "../public/images");


(async () => {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const conn = mongoose.connection;
  conn.once("open", async () => {
    const gfs = Grid(conn.db, mongoose.mongo);
    gfs.collection("uploads");

    const files = fs.readdirSync(IMAGES_DIR).filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f));

    for (const file of files) {
      const exists = await gfs.files.findOne({ filename: file });
      if (exists) continue;

      await new Promise((resolve, reject) => {
        const writeStream = gfs.createWriteStream({ filename: file });
        fs.createReadStream(path.join(IMAGES_DIR, file))
          .pipe(writeStream)
          .on("close", async () => {
            await Image.create({ filename: file });
            console.log("Stored:", file);
            resolve();
          })
          .on("error", reject);
      });
    }

    console.log("All local images imported to GridFS + Image collection");
    process.exit(0);
  });
})();
