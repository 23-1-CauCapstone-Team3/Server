const express = require("express");
const app = express();
const { pathRouter } = require("./routes/pathRouter");
const { taxiPathRouter } = require("./routes/taxiPathRouter");
const { saveDate } = require("./controllers/date-ctrl");
const port = 3000;

require("dotenv").config();

const server = async () => {
  try {
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use("/route", pathRouter);
    app.use("/taxiRoute", taxiPathRouter);

    app.listen(port, () => {
      // saveDate()
      console.log(`App listening on port ${port}`);
    });
  } catch (error) {
    console.log(error);
  }
};

server();
