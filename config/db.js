const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB connected to host: ${conn.connection.host}, db: ${conn.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB connection failed!');
    console.error(`Reason: ${error.message}`);
    process.exit(1); // Exit process with failure
  }
};

module.exports = connectDB;
