import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';

const app = express();

// Parse JSON with raw body capture for webhook signature verification
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }));

// --- ENV --- (add these to your env)
const {
  PORT = 3000,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  FLOW_ID, // WhatsApp Flow ID
  DELHIVERY_TOKEN, // Delhivery API token for create.json
  DELHIVERY_CHARGES_TOKEN, // token for charges GET (may be same as above)
  DELHIVERY_ORIGIN_PIN = '110042', // seller origin pin used in charges query
  DELHIVERY_CHARGES_URL = 'https://track.delhivery.com/api/kinko/v1/invoice/charges/.json',
  DELHIVERY_CREATE_URL = 'https://track.delhivery.com/api/cmu/create.json',
  GOOGLE_SERVICE_ACCOUNT_EMAIL = "logeshe48@gmail.com", // service account email
  GOOGLE_PRIVATE_KEY, // private key string (keep newlines as \n in env)
  SHEET_ID // google sheet id: e.g. 1uY-edY...
} = process.env;

if (!SHEET_ID) {
  console.warn('Warning: SHEET_ID not set. Google Sheets updates will fail until you set SHEET_ID env.');
}

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// --- STATE STORE ---
// We'll store sessions keyed by orderId (UUID). For backward compatibility we still keep phone->orderId map.
const orderSessions = {};        // orderId => session
const phoneToOrderIds = {};      // phone => [orderId,...]

// --- Helpers ---
function normalizePhone(phone) { return (phone || '').replace(/\D/g, ""); }

async function sendWhatsAppText(to, text) {
  try {
    await axios.post(GRAPH_URL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  } catch (err) {
    console.error('sendWhatsAppText error', err.response?.data || err.message || err);
  }
}

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
          catalog_id: "1262132998945503",
          sections: [
            {
              title: "Our Products",
              product_items: [
                { product_retailer_id: "43mypu8dye" },
                { product_retailer_id: "l722c63kq9" },
                { product_retailer_id: "kkii6r9uvh" },
                { product_retailer_id: "m519x5gv9s" },
                { product_retailer_id: "294l11gpcm" },
                { product_retailer_id: "ezg1lu6edm" },
                { product_retailer_id: "tzz72lpzz2" },
                { product_retailer_id: "esltl7pftq" },
                { product_retailer_id: "obdqyehm1w" }
              ]
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function sendWhatsAppFlow(to, flowId, flowToken = null) {
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Fill Delivery Details" },
      body: { text: "Please tap below to provide your info securely." },
      footer: { text: "OrangUtan Organics" },
      action: {
        name: "flow",
        parameters: {
          flow_id: flowId,
          flow_message_version: "3",
          flow_cta: "Enter Details"
        }
      }
    }
  };
  if (flowToken) data.interactive.action.parameters.flow_token = flowToken;
  await axios.post(GRAPH_URL, data, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });
}

// Razorpay link creation using reference_id = orderId (20 minutes expiry)
async function createRazorpayPaymentLink({ amountInPaise, description, customer, reference_id }) {
  const expire_by = Math.floor(Date.now() / 1000) + (20 * 60); // 20 minutes (>=15min required)
  const payload = {
    amount: amountInPaise,
    currency: "INR",
    description,
    customer,
    reference_id,
    notify: { sms: true, email: true },
    reminder_enable: true,
    expire_by
  };
  const res = await axios.post("https://api.razorpay.com/v1/payment_links", payload, {
    auth: { username: RAZORPAY_KEY_ID, password: RAZORPAY_KEY_SECRET }
  });
  return res.data;
}

// --- Delhivery: Get shipping charges ---
async function getDelhiveryCharges({ origin_pin = DELHIVERY_ORIGIN_PIN, dest_pin, cgm = 5000, pt = 'Pre-paid' }) {
  try {
    const params = {
      md: 'S',
      ss: 'Delivered',
      d_pin: dest_pin,
      o_pin: origin_pin,
      cgm,
      pt // 'Pre-paid' or 'Cash-on-Delivery' depending on Delhivery expectation
    };
    const res = await axios.get(DELHIVERY_CHARGES_URL, {
      headers: { Authorization: `Token ${DELHIVERY_CHARGES_TOKEN || DELHIVERY_TOKEN}`, 'Content-Type': 'application/json' },
      params
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery charges error', err.response?.data || err.message || err);
    throw err;
  }
}

// --- Delhivery: Create shipment ---
async function createDelhiveryShipment({ shipment, pickup_location = { name: "Delhivery Uttarkashi", add: "", city: "", pin: DELHIVERY_ORIGIN_PIN, phone: "" } }) {
  try {
    const payload = { shipments: [shipment], pickup_location };
    const bodyStr = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`;
    const res = await axios.post(DELHIVERY_CREATE_URL, bodyStr, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${DELHIVERY_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    return res.data;
  } catch (err) {
    console.error('Delhivery create error', err.response?.data || err.message || err);
    throw err;
  }
}

// --- Google Sheets append ---
let sheetsClient = null;
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.warn('Google service account credentials are missing. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY in env.');
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: "cred.json", // if you prefer env-based private key, swap to JWT client instead
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function appendToSheet(rowValues) {
  const sheets = getSheetsClient();
  if (!sheets || !SHEET_ID) {
    console.warn('Skipping Google Sheet append: sheets client or sheet id missing.');
    return null;
  }
  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowValues] }
    });
    return res.data;
  } catch (err) {
    console.error('appendToSheet error', err.response?.data || err.message || err);
    throw err;
  }
}


const getProductName =
      { "43mypu8dye":"Himalayan badri cow ghee 120gm" ,
        "l722c63kq9":"Himalayan badri cow ghee 295gm" ,
        "kkii6r9uvh":"Himalayan badri cow ghee 495gm" ,
        "m519x5gv9s":"Himalayan White Rajma 500gm" ,
        "294l11gpcm":"Himalayan White Rajma 1kg" ,
        "ezg1lu6edm":"Himalayan Red Rajma 500gm" ,
        "tzz72lpzz2":"Himalayan Red Rajma 1kg" ,
        "esltl7pftq":"Wild Himalayan Tempering Spice" ,
        "obdqyehm1w":"Himalayan Red Rice" };

const getProductWeight =
  { "43mypu8dye":"120" ,
    "l722c63kq9":"295" ,
    "kkii6r9uvh":"495" ,
    "m519x5gv9s":"500" ,
    "294l11gpcm":"1000" ,
    "ezg1lu6edm":"500" ,
    "tzz72lpzz2":"1000" ,
    "esltl7pftq":"100" , //150
    "obdqyehm1w":"1000" };

// --- WhatsApp Webhook Verification ---
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("webhook verified");
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

  // Ensure there's a fallback session keyed by phone for older flows (COD still working)
  if (!phoneToOrderIds[from]) phoneToOrderIds[from] = [];

  let session = null; // we'll create per-order sessions (orderId)
  let msgBody = "";
  if (msg.type === "text") {
    msgBody = msg.text?.body?.trim() || "";
  } else if (msg.type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      msgBody = msg.interactive.button_reply.title?.trim() || "";
    } else if (msg.interactive.type === "list_reply") {
      msgBody = msg.interactive.list_reply.title?.trim() || "";
    }
  } else if (msg.type === "order") {
    msgBody = "order_received";
  }

  // --- WhatsApp Flow submission hook ---
  if (msg?.interactive?.nfm_reply) {
    // Flow returns response_json as string - parse safely
    let customerData;
    try {
      customerData = JSON.parse(msg.interactive.nfm_reply.response_json);
    } catch (e) {
      console.warn("Failed to parse nfm_reply.response_json:", e);
      // If it's already an object, use it
      customerData = msg.interactive.nfm_reply.response_json;
    }

    // Ignore Meta test tokens
    if (customerData?.flow_token === 'test_101') {
      console.log('Ignoring meta test flow payload');
      return res.sendStatus(200);
    }

    // create a new orderId for this order (stable reference)
    const orderId = uuidv4();
    session = {
      orderId,
      phone: from,
      customer: customerData,
      step: 4,
      productItems: (orderSessions[from]?.productItems) || [], // fallback
      amount: (orderSessions[from]?.amount) || 0
    };

    // persist session by orderId
    orderSessions[orderId] = session;
    phoneToOrderIds[from].push(orderId);

    console.log("customer data = ", customerData);
    await sendWhatsAppText(from, `Thanks! We've received your delivery details. (OrderId: ${orderId})`);

    // Compute current session amount (should have been set earlier when user picked items)
    session.amount = session.amount || 0; // in paise

    // Payment mode expected in flow response under customerData.payment_mode
    const paymentMode = (customerData.payment_mode || '').toLowerCase();
    console.log("paymentMode:", paymentMode);

    

    // COD detection - be permissive
    if (paymentMode === 'cod' || paymentMode === 'cash on delivery' || paymentMode === 'cash-on-delivery') {
      // For COD: add ₹150 + shipping charges from Delhivery
            session.cod_error = true;
            const codChargePaise = 150 * 100;
            let shippingChargePaise = 0;
      
            //total weight of products
            const product_data = session.productItems;
            let total_wgt = 0
            for(let i=0;i<product_data.length;i++){
                // console.log(getProductWeight[a[i].product_retailer_id], a[i].quantity);
                total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
            }
      
            let final_product_name = "";
            for(let i=0;i<product_data.length;i++){
                // console.log(i);
                final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";  
            }
            final_product_name+="COD charge 150 + shipping charges included"
      
            // console.log("outsideee******** ",final_product_name);
            
      
      
      
            console.log("totalllll ***************** = ", total_wgt);
            
      
            
            
            try {
              // call Delhivery charges: cgm = 5000 (per your note)
              const chargesResp = await getDelhiveryCharges({
                origin_pin: DELHIVERY_ORIGIN_PIN,
                dest_pin: customerData.pincode || customerData.pin || '',
                cgm: total_wgt,
                pt: 'COD' // set pt based on COD; if Delhivery expects 'Pre-paid' for their price table, change accordingly
              });
              // Attempt to parse charge from response; structure differs by API version
              // We'll try a few keys, but if not present we'll fall back to 0 and continue.
              if (chargesResp) {
                // Example potential fields: chargesResp.charge, chargesResp.data.charge, chargesResp.result.charges etc.
                // We'll search for any numeric value in object properties named 'total' 'total_charge' 'charge' etc.
                // let possible = JSON.stringify(chargesResp);
                // console.log("test------>",possible);
                // console.log();
                
                // console.log("test------>",chargesResp.total_amount);
                // console.log("test------>",chargesResp[0].total_amount);   //this works
                
                const match = chargesResp[0].total_amount;
                console.log("----------> ", typeof match);
                
                if (match) {
                  // assume value in rupees if decimal or integer -> convert to paise
                  shippingChargePaise = Math.round(match * 100);
                } else {
                    session.cod_error = false;
                    console.warn('Could not reliably parse Delhivery charges response, defaulting shipping to 0. Response:', chargesResp);
                }
              }
            } catch (err) {
              session.cod_error = false;
              console.warn('Failed to get Delhivery charges, continuing with shippingChargePaise=0', err.message || err);
            }
      
            session.amount = (session.amount || 0) + codChargePaise + shippingChargePaise;
            session.payment_mode = 'COD';
            session.shipping_charge = shippingChargePaise;
            // session.cod_amount = codChargePaise;
      
            // Build shipment object for Delhivery create.json
            // console.log("insideeeee******** ",final_product_name);
            const shipment = {
              name: customerData.name || 'Customer',
              add: `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
              pin: customerData.pincode || customerData.pin || '',
              city: "",
              state: "",
              country: 'India',
              phone: customerData.phone || from,
              order: `Order_${Date.now()}`,
              payment_mode: "COD",
              return_pin: "",
              return_city: "",
              return_phone: "",
              return_add: "",
              return_state: "",
              return_country: "",
              products_desc: final_product_name,
              hsn_code: "",
              cod_amount: String(Math.round(session.amount / 100)), // rupees
              order_date: null,
              total_amount: String(Math.round(session.amount / 100)), // rupees
              seller_add: "",
              seller_name: "",
              seller_inv: "",
              quantity: "",
              waybill: "",
              shipment_width: "",
              shipment_height: "",
              weight: total_wgt, // optional
              shipping_mode: "Surface",
              address_type: ""
            };
      
            let delhiveryResp = null;
            delhiveryResp = await createDelhiveryShipment({ shipment });
            if(delhiveryResp.success && session.cod_error){
              // Append to Google Sheet
            try {
              const row = [
                new Date().toISOString(),
                customerData.name || '',
                customerData.phone || from,
                customerData.email || '',
                `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
                customerData.pincode || '',
                JSON.stringify(session.productItems || []),
                'COD',
                'Pending', // payment status for COD
                (session.amount / 100).toFixed(2), // amount in rupees
                (session.shipping_charge / 100).toFixed(2),
                (codChargePaise / 100).toFixed(2),
                JSON.stringify(delhiveryResp || {})
              ];
              await appendToSheet(row);
            } catch (err) {
              console.error('Failed to append COD order to sheet', err);
            }
      
            await sendWhatsAppText(from, `✅ Your COD order is placed. Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`);
            }
            else{
              await sendWhatsAppText(from, `✅ Data you enter in flow is incorrect, Make sure you enter vaid data`);
            }
      
      
      
            //---------------------------------------Changes logesh-----------------------------------
            // try {
            //   delhiveryResp = await createDelhiveryShipment({ shipment });
            //   // console.log("shipping things:  ", delhiveryResp);
            //   // console.log("shipping things1:  ",typeof delhiveryResp);
            //   console.log("shipping things2:  ", delhiveryResp.packages[0].remarks);
            //   // console.log("shipping things2:  ", delhiveryResp.packages[0].remarks);
      
              
            // } catch (err) {
            //   console.error('Delhivery shipment create failed for COD', err.message || err);
            // }
      
            // // Append to Google Sheet
            // try {
            //   const row = [
            //     new Date().toISOString(),
            //     customerData.name || '',
            //     customerData.phone || from,
            //     customerData.email || '',
            //     `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
            //     customerData.pincode || '',
            //     JSON.stringify(session.productItems || []),
            //     'COD',
            //     'Pending', // payment status for COD
            //     (session.amount / 100).toFixed(2), // amount in rupees
            //     (session.shipping_charge / 100).toFixed(2),
            //     (codChargePaise / 100).toFixed(2),
            //     JSON.stringify(delhiveryResp || {})
            //   ];
            //   await appendToSheet(row);
            // } catch (err) {
            //   console.error('Failed to append COD order to sheet', err);
            // }
      
            // await sendWhatsAppText(from, `✅ Your COD order is placed. Total: ₹${(session.amount/100).toFixed(2)}. We'll notify you when it's shipped.`);
      
            // finalize
            return res.sendStatus(200);
    } else {
      // PREPAID flow using orderId as reference_id
      console.log("prepaid part running .......");
      session.payment_mode = 'Prepaid';

      try {
        const customerPayload = {
          contact: customerData.phone || from,
          email: customerData.email,
          name: customerData.name
        };

        // Ensure we have session.amount; default 0
        session.amount = session.amount || 0;

        // Create payment link using reference_id = orderId and 20-min expiry
        const payLink = await createRazorpayPaymentLink({
          amountInPaise: session.amount,
          description: `Order from OrangUtan Organics - ${session.orderId}`,
          customer: customerPayload,
          reference_id: session.orderId
        });

        // Save link info to session
        session.razorpay_link_id = payLink.id;
        session.razorpay_short_url = payLink.short_url;
        session.razorpay_expire_by = payLink.expire_by;

        await sendWhatsAppText(from, `💳 Please complete your payment here: ${payLink.short_url}\n⏳ Valid for 20 minutes. OrderId: ${session.orderId}`);

        // Append preliminary row to sheet
        try {
          const row = [
            new Date().toISOString(),
            customerData.name || '',
            customerData.phone || from,
            customerData.email || '',
            `${customerData.address1 || ''} ${customerData.address2 || ''}`.trim(),
            customerData.pincode || '',
            JSON.stringify(session.productItems || []),
            'Prepaid',
            'Awaiting Payment',
            (session.amount / 100).toFixed(2),
            '', // shipping charge unknown yet
            '', // cod amount
            `razorpay_link:${payLink.id}`,
            session.orderId
          ];
          await appendToSheet(row);
        } catch (err) {
          console.error('Failed to append awaiting payment row to sheet', err);
        }

      } catch (err) {
        console.error('Failed to create razorpay payment link', err.response?.data || err.message || err);
        await sendWhatsAppText(from, `⚠️ Could not create payment link. Please try again later.`);
      }

      return res.sendStatus(200);
    }
  } // end flow handler

  console.log("Incoming:", msg.type, msgBody);

  try {
    // Greeting
    if (/^(hi|hello)$/i.test(msgBody)) {
      await sendWhatsAppText(from, "Namaste 🌱 Welcome to OrangUtan Organics! Type 'place order' to see our catalog.");
    }

    // Place order
    else if (/place order/i.test(msgBody)) {
      await sendWhatsAppCatalog(from);
      // store minimal phone-keyed placeholder so order items can be attached later
      if (!orderSessions[from]) orderSessions[from] = {};
      orderSessions[from].productItems = orderSessions[from].productItems || [];
      orderSessions[from].amount = orderSessions[from].amount || 0;
      await sendWhatsAppText(from, "Please select items from our catalog.");
    }

    // Catalog order + trigger flow
    else if (msg.type === "order" || msgBody === "order_received") {
      const phoneKeySession = orderSessions[from] || {};
      phoneKeySession.catalogId = msg.order?.catalog_id;
      phoneKeySession.productItems = msg.order?.product_items || [];

      let totalAmount = 0;
      for (const item of phoneKeySession.productItems) {
        const priceRupees = parseFloat(item.item_price) || 0;
        const qty = parseInt(item.quantity, 10) || 1;
        totalAmount += priceRupees * 100 * qty;
      }
      phoneKeySession.amount = totalAmount; // in paise
      orderSessions[from] = phoneKeySession;

      // Send WhatsApp Flow for delivery info
      await sendWhatsAppFlow(from, FLOW_ID);
      await sendWhatsAppText(from, "Please tap the button above and provide your delivery details.");
    }

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
  // IMPORTANT: use rawBody as string for signature verification
  const signature = req.headers['x-razorpay-signature'];
  let expected;
  try {
    expected = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody.toString())
      .digest("hex");
  } catch (e) {
    console.error("Signature calc error:", e);
    return res.status(400).send("Invalid signature");
  }

  if (signature !== expected) {
    console.log("Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  const event = req.body.event;
  const payment = req.body.payload.payment?.entity;
  const payment_link = req.body.payload.payment_link?.entity;

  // Try to resolve orderId from reference_id in payment_link (preferred), fallback to notes or phone mapping
  const orderId = payment_link?.reference_id || payment?.reference_id || payment?.notes?.orderId || null;

  console.log("Webhook event:", event, "orderId:", orderId, "payment:", JSON.stringify(payment || payment_link || {}, null, 2));

  let session = null;
  if (orderId && orderSessions[orderId]) {
    session = orderSessions[orderId];
  } else {
    // fallback: attempt to find session by phone in webhook payload
    let phone = "";
    if (payment) {
      if (payment.customer_contact) phone = normalizePhone(payment.customer_contact);
      else if (payment.customer?.contact) phone = normalizePhone(payment.customer.contact);
    }
    if (!phone && payment_link?.customer?.contact) phone = normalizePhone(payment_link.customer.contact);
    if (phone && phoneToOrderIds[phone] && phoneToOrderIds[phone].length) {
      const lastOrderId = phoneToOrderIds[phone][phoneToOrderIds[phone].length - 1];
      session = orderSessions[lastOrderId];
      console.warn("Fallback session found via phone mapping. orderId:", lastOrderId);
    }
  }

  if (!session) {
    console.log("No session found for this payment.");
    return res.sendStatus(200); // still return 200 to Razorpay
  }

  const phone = session.phone || '';
  try {
    if (event === "payment.captured" || event === "payment_link.paid" || event === "order.paid") {
      await sendWhatsAppText(phone, "✅ Payment successful! Your order is confirmed.");
      session.payment_status = 'paid';

      // compute shipping charges for prepaid using Delhivery
      let shippingChargePaise = 0;

      //total weight of products
      const product_data = session.productItems;
      console.log("prod_Data ------> ", product_data);
      
      let total_wgt = 0
      for(let i=0;i<product_data.length;i++){
          // console.log(getProductWeight[a[i].product_retailer_id], a[i].quantity);
          total_wgt+=getProductWeight[product_data[i].product_retailer_id]*product_data[i].quantity
      }

      let final_product_name = "";
      for(let i=0;i<product_data.length;i++){
          // console.log(i);
          final_product_name+=getProductName[product_data[i].product_retailer_id]+"("+product_data[i].quantity+")"+"\n";  
      }
      final_product_name+="shipping charges included"



      try {
        const chargesResp = await getDelhiveryCharges({
          origin_pin: DELHIVERY_ORIGIN_PIN,
          dest_pin: session.customer?.pincode || session.customer?.pin || '',
          cgm: total_wgt,
          pt: 'Pre-paid'
        });
        if (chargesResp) {
          // const possible = JSON.stringify(chargesResp);
          const match = chargesResp[0].total_amount;
          if (match) {
            shippingChargePaise = Math.round(match * 100);
          }
          else {
            console.warn("Could not parse delhivery charges response:", chargesResp);
          }
        }
      } catch (err) {
        console.warn('Error while retrieving delhivery charges for prepaid', err.message || err);
      }

      session.shipping_charge = shippingChargePaise;

      // Build shipment for Delhivery
      const shipment = {
        name: session.customer?.name || 'Customer',
        add: `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
        pin: session.customer?.pincode || session.customer?.pin || '',
        city: session.customer?.city || '',
        state: session.customer?.state || '',
        country: 'India',
        phone: session.customer?.phone || phone,
        order: `Order_${session.orderId || Date.now()}`,
        payment_mode: "Prepaid",
        return_pin: "",
        return_city: "",
        return_phone: "",
        return_add: "",
        return_state: "",
        return_country: "",
        products_desc: final_product_name,
        hsn_code: "",
        cod_amount: "0",
        order_date: null,
        total_amount: String(Math.round(session.amount / 100)), // rupees
        seller_add: "",
        seller_name: "",
        seller_inv: "",
        quantity: "",
        waybill: "",
        shipment_width: "100",
        shipment_height: "100",
        weight: "",
        shipping_mode: "Surface",
        address_type: ""
      };

      let delhiveryResp = null;
      try {
        delhiveryResp = await createDelhiveryShipment({ shipment });
        console.log("Delhivery create response:", delhiveryResp);
        await sendWhatsAppText(phone, `📦 Shipment created. We'll share tracking once available.`);
      } catch (err) {
        console.error('Delhivery create after payment failed', err.message || err);
        await sendWhatsAppText(phone, `⚠️ Payment received but shipment creation failed. We'll follow up.`);
      }

      // Append final row to sheet marking paid and shipment info
      try {
        const row = [
          new Date().toISOString(),
          session.customer?.name || '',
          session.customer?.phone || phone,
          session.customer?.email || '',
          `${session.customer?.address1 || ''} ${session.customer?.address2 || ''}`.trim(),
          session.customer?.pincode || '',
          JSON.stringify(session.productItems || []),
          'Prepaid',
          'Paid',
          (session.amount / 100).toFixed(2),
          (session.shipping_charge / 100).toFixed(2),
          '0.00',
          JSON.stringify(delhiveryResp || {}),
          session.orderId || ''
        ];
        await appendToSheet(row);
      } catch (err) {
        console.error('Failed to append prepaid paid order to sheet', err);
      }

    } else if (event === "payment_link.expired") {
      await sendWhatsAppText(phone, "⌛ Your payment link expired (15 minutes limit). Please place your order again.");
      session.payment_status = 'failed';
    }
  } catch (err) {
    console.error("Failed to send WhatsApp message after payment:", err);
  }

  res.sendStatus(200);
});

// --- Start ---
app.listen(PORT, () => console.log(`Bot running on :${PORT}`));
