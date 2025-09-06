import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const app = express();

// Parse JSON with raw body capture for webhook signature verification
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// --- ENV ---
const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// --- STATE STORE (in-memory for demo, use DB in prod) ---
const orderSessions = {}; // { normalizedPhone: { step, catalogId, productItems, details, amount, razorpayOrderId } }

// --- Helpers ---

// Normalize phone numbers (remove +, spaces, etc.)
function normalizePhone(phone) {
  return phone.replace(/\D/g, "");
}

// Send WhatsApp text
async function sendWhatsAppText(to, text) {
  await axios.post(GRAPH_URL, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

// Send WhatsApp catalog
async function sendWhatsAppCatalog(to) {
  await axios.post(GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "product_list",
        header: { type: "text", text: "Featured Products 🌟" },
        body: { text: "Browse our catalog and pick your favorites 🌱" },
        footer: { text: "OrangUtan Organics" },
        action: {
          catalog_id: "1262132998945503", // must match linked catalog in WABA
          sections: [
            {
              title: "Our Products",
              product_items: [
                { product_retailer_id: "ezg1lu6edm" },
                { product_retailer_id: "m519x5gv9s" },
                { product_retailer_id: "esltl7pftq" },
                { product_retailer_id: "obdqyehm1w" },
                { product_retailer_id: "l722c63kq9" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// Create Razorpay payment link
async function createRazorpayPaymentLink({ amountInPaise, description, customer }) {
  const res = await axios.post("https://api.razorpay.com/v1/payment_links", {
    amount: amountInPaise,
    currency: "INR",
    description,
    customer,
    notify: { sms: true, email: true },
    reminder_enable: true,
  }, {
    auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET }
  });
  return res.data;
}

// --- WhatsApp Webhook Verification ---
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- WhatsApp Incoming Messages ---
app.post('/', async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const fromRaw = msg.from;
  const from = normalizePhone(fromRaw);

  if (!orderSessions[from]) orderSessions[from] = { step: 0 };
  const session = orderSessions[from];

  // Safely extract body depending on type
  let msgBody = "";
  if (msg.type === "text") {
    msgBody = msg.text?.body?.toLowerCase().trim() || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      msgBody = msg.interactive.button_reply.title?.toLowerCase().trim() || "";
    } else if (msg.interactive.type === "list_reply") {
      msgBody = msg.interactive.list_reply.title?.toLowerCase().trim() || "";
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  }

  console.log("Incoming:", msg.type, msgBody);

  try {
    // Greeting
    if (msgBody === "hi" || msgBody === "hello") {
      await sendWhatsAppText(from, "Namaste 🌱 Welcome to OrangUtan Organics! Type 'place order' to see our catalog.");
    }

    // Place order
    else if (msgBody.includes("place order")) {
      await sendWhatsAppCatalog(from);
      session.step = 1;
      await sendWhatsAppText(from, "Please select items from our catalog.");
    }

    // Catalog order
    else if (msg.type === "order" || msgBody === "order_received") {
      session.catalogId = msg.order?.catalog_id;
      session.productItems = msg.order?.product_items || [];

      console.log("RAW ORDER MESSAGE:", JSON.stringify(msg, null, 2));

      let totalAmount = 0;
      for (const item of session.productItems) {
        const priceRupees = parseFloat(item.item_price) || 0; // WhatsApp sends rupees
        const qty = parseInt(item.quantity, 10) || 1;
        totalAmount += priceRupees * 100 * qty; // convert to paise
      }

      session.amount = totalAmount;
      session.step = 2;

      await sendWhatsAppText(
        from,
        `Got your order ✅ Total: ₹${(session.amount / 100).toFixed(2)}\n\nPlease share your name, email, and delivery address.`
      );
    }

    // Collect details & generate payment
    else if (session.step === 2 && msgBody) {
      session.details = msgBody;
      const payLink = await createRazorpayPaymentLink({
        amountInPaise: session.amount,
        description: "Order from OrangUtan Organics",
        customer: { contact: from }
      });
      session.razorpayOrderId = payLink.id;
      session.step = 3;
      await sendWhatsAppText(from, `Please complete your payment here: ${payLink.short_url}`);
    }

    // Anything else
    else {
      await sendWhatsAppText(from, "Sorry, I didn’t understand that. Type *hi* to get started.");
    }

  } catch (err) {
    console.error("Handler error:", err.response?.data || err);
  }

  res.sendStatus(200);
});

// --- Razorpay Webhook ---
app.post('/razorpay-webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("hex");

  if (signature !== expected) {
    console.log("Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  const payment = req.body.payload.payment?.entity;

  // --- FIX: Get phone from all possible places ---
  let phone = "";
  if (payment) {
    if (payment.customer_contact) phone = normalizePhone(payment.customer_contact);
    else if (payment.customer?.contact) phone = normalizePhone(payment.customer.contact);
  }
  if (!phone) {
    const pl = req.body.payload.payment_link?.entity?.customer?.contact;
    if (pl) phone = normalizePhone(pl);
  }

  const session = orderSessions[phone];

  console.log("Webhook event:", event, "for phone:", phone || "(none)");

  if (session) {
    try {
      if (event === "payment.captured" || event === "payment_link.paid") {
        await sendWhatsAppText(phone, "✅ Payment successful! Your order is confirmed.");
      } else if (event === "payment.failed") {
        await sendWhatsAppText(phone, "⚠️ Payment failed. Please try again with the link we sent.");
      }
    } catch (err) {
      console.error("Failed to send WhatsApp message after payment:", err);
    }
  } else {
    console.log("No session found for this payment.");
  }

  res.sendStatus(200);
});


// --- Start ---
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
