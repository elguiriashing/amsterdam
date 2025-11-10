import dotenv from "dotenv";
dotenv.config(); // load env variables first

import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from 'node-fetch';
import { startTelegramBot } from "./services/telegramwiper.js";

 // ✅ Launch the bot on server start




// --- Environment Variables (loaded from Railway) ---
const ADMIN_PASS = process.env.ADMIN_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
const MONGO_URI = process.env.MONGO_URI;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- Telegram Notification Helper ---
export async function sendTelegramNotification(text) {
  try {
    // Send message
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });

    const data = await res.json();
    if (!data.ok) throw new Error(data.description);

    const messageId = data.result.message_id;

    // Schedule self-destruct (48 hours)
    setTimeout(async () => {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            message_id: messageId,
          }),
        });
        console.log(`💥 Auto-deleted Telegram message ${messageId}`);
      } catch (err) {
        console.error(`❌ Failed to delete Telegram message ${messageId}:`, err.message);
      }
    }, 48 * 60 * 60 * 1000); // 48h

    return true;
  } catch (err) {
    console.error("Error sending Telegram notification:", err);
    return false;
  }
}


const app = express();
app.use(cors());
app.use(express.json());

// 🌿 MongoDB Setup
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  ssl: true,
});

let db;
async function connectDB() {
  try {
    await client.connect();
    db = client.db("Amsterdam0");
    console.log("✅ Connected to MongoDB!");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}
connectDB();

// --- Start Telegram Bot ---
startTelegramBot(); // 🟢 Launch bot on server start with test startup message

// --- ROUTES ---

app.get("/", (req, res) => {
  res.send("Server is live! 🌿");
});

// 🔐 Admin login (will be deprecated once full member auth is in)
app.post("/api/admin-login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASS) {
    const adminToken = generateToken({ _id: 'admin', email: 'admin', name: 'Admin' });
    res.json({ success: true, message: "Welcome back boss 🌿", token: adminToken });
  } else {
    res.status(401).json({ success: false, message: "Incorrect password" });
  }
});

// Middleware to protect member routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401); // No token

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Invalid token
    req.user = user;
    next();
  });
}

// 👤 Member login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const member = await db.collection("members").findOne({ email });

  if (member == null) {
    return res.status(400).send("Cannot find member");
  }

  // Check for expired membership
  if (member.membershipEndDate && new Date(member.membershipEndDate) < new Date()) {
    return res.status(403).send("Membership expired");
  }

  try {
    if (await bcrypt.compare(password, member.password)) {
      const token = generateToken(member);
      res.json({ user: { id: member._id, name: member.name, email: member.email }, token });
    } else {
      res.status(403).send("Not Allowed");
    }
  } catch (err) {
    res.status(500).send();
  }
});

// 👥 Get all members (Admin only)
app.get("/api/members", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') { // Simple admin check for now
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const members = await db.collection("members").find().toArray();
    // Add a check for membership expiry here before sending to frontend
    const membersWithExpiryStatus = members.map(member => ({
      ...member,
      isExpired: new Date(member.membershipEndDate) < new Date()
    }));
    res.json(membersWithExpiryStatus);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch members", details: err });
  }
});

// ➕ Add a new member (Admin only)
app.post("/api/members", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing name, email, or password" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log(`New member email: ${email}, Hashed Password: ${hashedPassword}`); // Add this line for debugging
    
    const membershipEndDate = new Date();
    membershipEndDate.setFullYear(membershipEndDate.getFullYear() + 1);

    const result = await db.collection("members").insertOne({ name, email, password: hashedPassword, createdAt: new Date(), membershipEndDate });
    res.status(201).json({ success: true, message: "Member added.", memberId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: "Failed to add member", details: err });
  }
});

// 🗑️ Delete a member (Admin only)
app.delete("/api/members/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("members").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Member deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete member", details: err });
  }
});

// ✏️ Update a member (Admin only)
app.put("/api/members/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { name, email, membershipEndDate } = req.body;

    if (!name || !email || !membershipEndDate) {
      return res.status(400).json({ error: "Missing name, email, or membership end date" });
    }

    // Note: Password changes should ideally be handled via a separate, secure flow.
    // Here, we're only allowing name, email, and membershipEndDate to be updated.
    await db.collection("members").updateOne(
      { _id: new ObjectId(id) },
      { $set: { name, email, membershipEndDate: new Date(membershipEndDate), updatedAt: new Date() } }
    );
    res.json({ success: true, message: "Member updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update member", details: err });
  }
});

// 🍃 Get full menu (Protected for members)
app.get("/api/menu", authenticateToken, async (req, res) => {
  try {
    const menu = await db.collection("menu").find().toArray();
    res.json(menu);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch menu", details: err });
  }
});

// ➕ Add new strain to menu
app.post("/api/menu", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { strainName, type, thc, terpenes, description } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });

    await db.collection("menu").insertOne({
      strainName,
      type,
      thc,
      terpenes,
      description,
      addedAt: new Date(),
    });
    res.json({ success: true, message: "Strain added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add menu item", details: err });
  }
});

// 🗑️ Delete a strain
app.delete("/api/menu/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("menu").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete menu item", details: err });
  }
});

// ✏️ Update a strain
app.put("/api/menu/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { strainName, type, thc, terpenes, description } = req.body;
    if (!strainName) return res.status(400).json({ error: "Missing strain name" });

    await db.collection("menu").updateOne(
      { _id: new ObjectId(id) },
      { $set: { strainName, type, thc, terpenes, description, updatedAt: new Date() } }
    );
    res.json({ success: true, message: "Menu item updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update menu item", details: err });
  }
});

// 🧾 Get editable content (events/info)
app.get("/api/content", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const content = await db.collection("content").find().toArray();
    res.json(content);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch content", details: err });
  }
});

// ✏️ Update or create content section
app.post("/api/update-content", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { section, data } = req.body;
    if (!section) return res.status(400).json({ error: "Missing section name" });

    await db.collection("content").updateOne(
      { section },
      { $set: { data, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, message: "Content updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update content", details: err });
  }
});

// 🧠 Prefill Memberships (public bluff form)
app.post("/api/prefill", async (req, res) => {
  try {
    const { fullname, phone, email, ts } = req.body;
    // Save pre-fill data to a new 'prefills' collection
    await db.collection("prefills").insertOne({ fullname, phone, email, ts: new Date(ts), status: "pending" });
    
    // Send Telegram notification
    const notificationMessage = `📥<b>New Web Membership Prefill!</b>📥\n\n<b>Name:</b> ${fullname}\n<b>Email:</b> ${email}\n<b>Phone:</b> ${phone}\n<b>Received:</b> ${new Date(ts).toLocaleString()}\n\n📱<b>Check it out in the panel</b>📱\nhttps://blueelephantstudio.pages.dev/admin`;
    await sendTelegramNotification(notificationMessage);

    res.status(200).send("Pre-fill data received");
  } catch (err) {
    console.error("Error saving pre-fill data:", err);
    res.status(500).send("Error saving pre-fill data");
  }
});

// ADMIN ONLY: Get all pre-fills
app.get("/api/prefills", authenticateToken, async (req, res) => {
  try {
    const prefillData = await db.collection("prefills").find({}).sort({ ts: -1 }).toArray();
    res.json(prefillData);
  } catch (err) {
    console.error("Error fetching pre-fills:", err);
    res.status(500).send("Error fetching pre-fills");
  }
});

// ADMIN ONLY: Delete a pre-fill
app.delete("/api/prefills/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection("prefills").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).send("Pre-fill not found");
    }
    res.status(200).send("Pre-fill deleted");
  } catch (err) {
    console.error("Error deleting pre-fill:", err);
    res.status(500).send("Error deleting pre-fill");
  }
});

// 📰 Members-only posts (for dashboard demo)
app.get("/api/posts", authenticateToken, async (req, res) => {
  // For members, anyone authenticated can view posts
  try {
    const posts = await db.collection("posts").find().sort({ _id: -1 }).toArray();
    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch posts", details: err });
  }
});

// ➕ Add a post (for admin dashboard in future)
app.post("/api/posts", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { title, body } = req.body;
    if (!title) return res.status(400).json({ error: "Missing title" });

    await db.collection("posts").insertOne({ title, body, createdAt: new Date() });
    res.json({ success: true, message: "Post added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add post", details: err });
  }
});

// 🗓️ Get all events
app.get("/api/events", async (req, res) => {
  try {
    const events = await db.collection("events").find().sort({ date: 1 }).toArray();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch events", details: err });
  }
});

// ➕ Add a new event (Admin only)
app.post("/api/events", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const { title, description, date, time } = req.body;
    if (!title || !date || !time) {
      return res.status(400).json({ error: "Missing title, date, or time" });
    }
    await db.collection("events").insertOne({ title, description, date: new Date(date), time, createdAt: new Date() });
    res.status(201).json({ success: true, message: "Event added." });
  } catch (err) {
    res.status(500).json({ error: "Failed to add event", details: err });
  }
});

// ✏️ Update an event (Admin only)
app.put("/api/events/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    const { title, description, date, time } = req.body;
    if (!title || !date || !time) {
      return res.status(400).json({ error: "Missing title, date, or time" });
    }
    await db.collection("events").updateOne(
      { _id: new ObjectId(id) },
      { $set: { title, description, date: new Date(date), time, updatedAt: new Date() } }
    );
    res.json({ success: true, message: "Event updated." });
  } catch (err) {
    res.status(500).json({ error: "Failed to update event", details: err });
  }
});

// 🗑️ Delete an event (Admin only)
app.delete("/api/events/:id", authenticateToken, async (req, res) => {
  if (req.user.id !== 'admin') {
    return res.status(403).json({ message: 'Access denied' });
  }
  try {
    const id = req.params.id;
    await db.collection("events").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Event deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete event", details: err });
  }
});

function generateToken(user) {
  return jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "1h" });
}

// 🖥️ Server setup
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
