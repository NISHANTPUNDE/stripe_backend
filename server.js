const express = require("express");
const cors = require("cors");
require("dotenv").config();
const bodyParser = require("body-parser");
const { MongoClient, ServerApiVersion } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const uri = process.env.MONGO_URI;
const endpointSecret = process.env.WEBHOOK_SIGNING_SECRET;

const client = new MongoClient(uri
  // , {
  // serverApi: {
  //   version: ServerApiVersion.v1,
  //   strict: true,
  //   deprecationErrors: true,
  // },}
);

// Connect to the client
client.connect();

const app = express();
app.use(cors());

app.use(express.json());
app.use(bodyParser.raw({ type: "application/json" }))
app.post("/create-stripe-session-subscription", async (req, res) => {
  console.log(req.body.email, req.body.planname);
  const userEmail = req.body.email; // Replace with actual user email
  let customer;
  const auth0UserId = userEmail;
  let session; // Declare session variable here

  // Try to retrieve an existing customer by email
  const existingCustomers = await stripe.customers.list({
    email: userEmail,
    limit: 1,
  });

  if (existingCustomers.data.length > 0) {
    customer = existingCustomers.data[0];

    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "active",
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      const stripeSession = await stripe.billingPortal.sessions.create({
        customer: customer.id,
        return_url: "http://localhost:3000/success",
      });
      return res.status(409).json({ redirectUrl: stripeSession.return_url });
    }
  } else {
    // No customer found, create a new one
    customer = await stripe.customers.create({
      email: userEmail,
      metadata: {
        userId: auth0UserId,
      },
    });
  }

  // Now create the Stripe checkout session with the customer ID
  if (req.body.interval === "trial") {
    console.log("hello");
    session = await stripe.checkout.sessions.create({
      success_url:
        "https://admin.shopify.com/store/dev-demosky/apps/subscription-app-142/index",
      cancel_url:
        "https://admin.shopify.com/store/dev-demosky/apps/subscription-app-142/Cancel",
      payment_method_types: ["card"],
      mode: "subscription",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "inr",
            product_data: {
              name: req.body.planname,
              description: "Free Trial",
            },
            unit_amount: 0,
            recurring: { interval: "day", interval_count: 7 },
          },
          quantity: 1,
        },
      ],
      customer_email: userEmail,
    });
  } else {
    session = await stripe.checkout.sessions.create({
      success_url:
        "https://admin.shopify.com/store/dev-demosky/apps/subscription-app-142/index",
      cancel_url:
        "https://admin.shopify.com/store/dev-demosky/apps/subscription-app-142/Cancel",
      payment_method_types: ["card"],
      mode: "subscription",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "inr",
            product_data: {
              name: req.body.planname,
              description:
                req.body.interval === "month"
                  ? "Monthly Subscription"
                  : "Yearly Subscription",
            },
            unit_amount: req.body.interval === "month" ? 20000 : 5000000,
            recurring: {
              interval: req.body.interval,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId: auth0UserId,
      },
      customer: customer.id,
    });
  }
  res.json({ id: session.id });
});




app.post("/webhook",  async (req, res) => {
  const db = client.db("subDB");
  console.log(client.db("subDB"));
  const subscriptions = db.collection("subscriptions");

  const payload = req.body;
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
  } catch (err) {
    // Log the error
    console.error("Webhook Error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object;

    // On payment successful, get subscription and customer details
    const subscription = await stripe.subscriptions.retrieve(
      event.data.object.subscription
    );
    const customer = await stripe.customers.retrieve(
      event.data.object.customer
    );

    console.log(subscription, customer);

    if (invoice.billing_reason === "subscription_create") {

      const subscriptionDocument = {
        userId: customer?.metadata?.userId,
        subId: event.data.object.subscription,
        endDate: subscription.current_period_end * 1000,
      };

      try {
        // Insert the document into the collection
        const result = await subscriptions.insertOne(subscriptionDocument);
        console.log(`A document was inserted with the _id: ${result.insertedId}`);
      } catch (err) {
        // Log the error
        console.error("MongoDB Insert Error:", err.message);
      }

      console.log(
        `First subscription payment successful for Invoice ID: ${customer.email} ${customer?.metadata?.userId}`
      );
    } else if (
      invoice.billing_reason === "subscription_cycle" ||
      invoice.billing_reason === "subscription_update"
    ) {
      // Handle recurring subscription payments
      // DB code to update the database for recurring subscription payments

      // Define the filter to find the document with the specified userId
      const filter = { userId: customer?.metadata?.userId };

      // Define the update operation to set the new endDate
      const updateDoc = {
        $set: {
          endDate: subscription.current_period_end * 1000,
          recurringSuccessful_test: true,
        },
      };

      try {
        // Update the document
        const result = await subscriptions.updateOne(filter, updateDoc);
        if (result.matchedCount === 0) {
          console.log("No documents matched the query. Document not updated");
        } else if (result.modifiedCount === 0) {
          console.log("Document matched but not updated (it may have the same data)");
        } else {
          console.log("Successfully updated the document");
        }
      } catch (err) {
        // Log the error
        console.error("MongoDB Update Error:", err.message);
      }

      console.log(
        `Recurring subscription payment successful for Invoice ID: ${invoice.id}`
      );
    }

    console.log(
      new Date(subscription.current_period_end * 1000),
      subscription.status,
      invoice.billing_reason
    );
  }

  // For canceled/renewed subscription
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    // console.log(event);
    if (subscription.cancel_at_period_end) {
      console.log(`Subscription ${subscription.id} was canceled.`);
      // DB code to update the customer's subscription status in your database
    } else {
      console.log(`Subscription ${subscription.id} was restarted.`);
      // get subscription details and update the DB
    }
  }

  res.status(200).end();
});



app.listen(3001, () => {
  console.log("Server is running on port 3001");
});

process.on("SIGINT", () => {
  client.close().then(() => {
    console.log("MongoDB disconnected on app termination");
    process.exit(0);
  });
});