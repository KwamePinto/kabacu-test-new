const mongoose = require('mongoose');

const connectMongoDB = async () => {

	try{
		mongoose.set('strictQuery', false)

		const conn = await mongoose.connect(process.env.MONGO_URI, {
			maxPoolSize: 20,
			serverSelectionTimeoutMS: 5000,
			socketTimeoutMS: 45000,
		})
		console.log(`Database connected: ${conn.connection.host}`)

		// Drop non-sparse unique indexes so Mongoose recreates them as sparse
		// (allows multiple documents with the field missing/null).
		const indexDrops = [
			{ col: 'users',  idx: 'minerId_1' },
			{ col: 'topups', idx: 'reference_1' },
		];
		for (const { col, idx } of indexDrops) {
			try {
				await conn.connection.collection(col).dropIndex(idx);
				console.log(`Dropped stale index ${idx} on ${col}`);
			} catch (e) {
				// Already dropped or never existed — ignore
			}
		}

	}catch(error){
		console.log(error)
	}
}

module.exports = connectMongoDB;


/**from the above no OTP is needed, and no external api, and also kindly add the controllers and routes for the convention logic */