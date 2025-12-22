require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // await client.connect()

    const db = client.db("loanLink-db");
    const loansCollection = db.collection("loans");
    const applyLoansCollection = db.collection("borrowerLoansApply");
    const paymentCollection = db.collection("payments")
    const userCollection = db.collection("users")

    // Save a manager create loan data in db
    app.post("/loans", async (req, res) => {
      const loanData = req.body;
      console.log(loanData);

      //auto date form submit time
      loanData.createdAt = new Date().toISOString();

      const result = await loansCollection.insertOne(loanData);
      res.send(result);
    });

    // get all loans from db
    app.get("/loans", async (req, res) => {
      const result = await loansCollection.find().toArray();
      res.send(result);
    });

    // get borrower all apply loan from db
    app.get("/apply-loans", async (req, res) => {
      const result = await paymentCollection.find().toArray();
      res.send(result);
    });

    // get all loans from db
    app.get("/loans/:id", async (req, res) => {
      const id = req.params.id;
      const result = await loansCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Save Borrower loans application from db
    app.post("/borrowerLoansApply", async (req, res) => {
      const borrowerLoanData = req.body;
      console.log(borrowerLoanData);

      // //auto form submit time
      borrowerLoanData.createdAt = new Date().toISOString();

      const result = await applyLoansCollection.insertOne(borrowerLoanData);
      res.send(result);
    });


    // BORROWER ROUTE

    // get all loan application for a borrower by email
    app.get('/my-loans', verifyJWT, async (req, res) => {
      // console.log('email param', email)

     const result = await applyLoansCollection.find({borrowerEmail: req.tokenEmail}).toArray()
     res.send(result)
    })


    // MANAGER ROUTE

    // get manage add loan data for a manager by email
    app.get("/manage-loans/:email", async (req, res) => {
      const email = req.params.email
      const result = await loansCollection.find({'createdBy.email': email}).toArray();
      console.log(result)
      res.send(result);
    });


    // get Pending Applications loan data for a manager
    app.get("/pending-applications/:email", async (req, res) => {
      const email = req.params.email
      const result = await applyLoansCollection.find({borrowerEmail: email}).toArray();
      console.log(result)
      res.send(result);
    });

    

    // Payment endpoints
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo)
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: paymentInfo?.borrower.name,
                images: [paymentInfo?.borrower?.image]
              },
              unit_amount: 1000
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.borrower?.email,
        mode: 'payment',
        metadata: {
          loanId: paymentInfo?.loanId,
          name: paymentInfo?.borrower?.name,
          borrower: paymentInfo?.borrower?.email,
          loanTitle: paymentInfo?.title,
          category: paymentInfo?.category,
          loanAmount: paymentInfo?.loanAmount
        },
        // success_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-loans?session_id={CHECKOUT_SESSION_ID}`,
        success_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-loans`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-loans`
      });
      res.send({ url: session.url})
    });

    //payment paid and status change to unpaid to paid
    app.post("/payment-paid", async (req, res) => {
      const {sessionId} = req.body
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log(session)
      
      const loan = await applyLoansCollection.findOne({_id: new ObjectId(session.metadata.loanId)})
      
      const payment = await paymentCollection.findOne({transactionId: session.payment_intent})

      if(session.payment_status === 'paid' && loan && !payment) {
        //save order data in db
        const loanApplyInfo = {
          loanId: session.metadata.loanId,
          transactionId: session.payment_intent,
          borrower: session.metadata.borrower,
          name: session.metadata.name,
          status: 'pending',
          amount: session.amount_total / 100,
          loanTitle: session.metadata.loanTitle,
          category: session.metadata.category,
          loanAmount: loan.loanAmount,
          date: new Date().toISOString(),
        }
        const result = await paymentCollection.insertOne(loanApplyInfo)
      }
    })

    // save or update a user in db
    app.post("/user", async (req, res) => {
      const userData = req.body

    // default role if not provided
      userData.role = userData.role || "borrower";
      userData.status = "active"

      userData.created_at = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()

      const query = {email: userData.email}

      const alreadyExists = await userCollection.findOne(query)
      console.log('user already Exists---->', !!alreadyExists)

      if (alreadyExists) {
        console.log('Updating user info......')

        const result = await userCollection.updateOne(query, {$set:{last_loggedIn: new Date().toISOString()}})
        return res.send(result)
      }

      // const newUser


      console.log('Saving new user info......')
      const result = await userCollection.insertOne(userData)
      res.send(result)
    })

    // get a user's role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await userCollection.findOne({email: req.tokenEmail})
      res.send({role: result?.role})
    })


    // ADMIN ROUTE

    //get all user for admin
    app.get('/all-user', verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail
      const result = await userCollection.find({email: {$ne: adminEmail}}).toArray()
      res.send(result)
    })

    // update a user's role
    app.patch('/update-role', verifyJWT, async (req, res) => {
      const {email, role} = req.body
      const result = await userCollection.updateOne({email}, {$set: {role}})
      
      res.send(result)
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});


// app.listen(port, () => {
//   console.log(`Server is running on port ${port}`);
// });
