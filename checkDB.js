require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection;

  const uploads = await db.collection("uploads.files").find().toArray();
  console.log("GridFS files:", uploads.map(f => f.filename));

  const images = await db.collection("images").find().toArray();
  console.log("Image collection:", images.map(i => i.filename));

  process.exit(0);
})();
