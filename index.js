const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// CONFIG
const SHOP = process.env.SHOP; // CHANGE THIS
const TOKEN = process.env.TOKEN; // shpat_...
const MONGO_URI = process.env.MONGODB_URI; // mongodb+srv://...
const CRON_SECRET = process.env.CRON_SECRET || "my_super_secret_password";
// 1. CONNECT TO MONGO
mongoose.connect(MONGO_URI)
  .then(() => console.log("DB Connected"))
  .catch(err => console.error("DB Error", err));

// 2. DEFINE SCHEMA
const JobSchema = new mongoose.Schema({
  variantId: String,
  originalPrice: String, // We save this to revert later
  discountPercent: Number,
  startTime: Date,
  endTime: Date,
  status: { 
    type: String, 
    enum: ['pending', 'active', 'completed'], 
    default: 'pending' 
  }
});
const Job = mongoose.model('Job', JobSchema);

// 3. CORS (Allow Editor access)
app.use(cors({ origin: '*' }));

// --- ROUTE 1: SAVE THE SCHEDULE ---
app.post('/api/schedule', async (req, res) => {
  const { variantIds, discount, startAt, endAt } = req.body;

  if (!variantIds || !variantIds.length) return res.status(400).json({ error: "No IDs" });

  try {
    // Create a job entry for EACH variant
    const jobs = variantIds.map(id => ({
      variantId: id,
      discountPercent: discount,
      startTime: new Date(startAt),
      endTime: new Date(endAt),
      status: 'pending'
    }));

    await Job.insertMany(jobs);
    res.json({ success: true, message: `Scheduled ${jobs.length} updates.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- ROUTE 2: THE CRON JOB (Runs every minute) ---
app.get('/api/cron', async (req, res) => {
    // We check if the URL has ?key=my_super_secret_password
  if (req.query.key !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized. Shoo!" });
  }
  const now = new Date();
  const log = { started: 0, reverted: 0, errors: [] };

  try {
    // A. FIND JOBS TO START (Time is passed, Status is Pending)
    const toStart = await Job.find({ 
      startTime: { $lte: now }, 
      status: 'pending' 
    }).limit(20); // Process in chunks to avoid timeouts

    for (const job of toStart) {
      try {
        // 1. Fetch current price (to save it)
        const getRes = await fetch(`https://${SHOP}/admin/api/2024-01/variants/${job.variantId}.json`, {
          headers: { 'X-Shopify-Access-Token': TOKEN }
        });
        const data = await getRes.json();
        const currentPrice = data.variant.price;

        // 2. Calculate Discount
        const newPrice = (currentPrice * (1 - job.discountPercent / 100)).toFixed(2);

        // 3. Update Shopify
        await fetch(`https://${SHOP}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: { id: job.variantId, price: newPrice } })
        });

        // 4. Update DB
        job.originalPrice = currentPrice;
        job.status = 'active';
        await job.save();
        log.started++;
      } catch (e) {
        log.errors.push(e.message);
      }
    }

    // B. FIND JOBS TO REVERT (Time is passed, Status is Active)
    const toRevert = await Job.find({ 
      endTime: { $lte: now }, 
      status: 'active' 
    }).limit(20);

    for (const job of toRevert) {
      try {
        // 1. Revert to original price
        await fetch(`https://${SHOP}/admin/api/2024-01/variants/${job.variantId}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: { id: job.variantId, price: job.originalPrice } })
        });

        // 2. Mark complete
        job.status = 'completed';
        await job.save();
        log.reverted++;
      } catch (e) {
        log.errors.push(e.message);
      }
    }

    res.json({ success: true, log });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = app;