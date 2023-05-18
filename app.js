const express = require("express");
const app = express();
const { taxiPathRouter } = require("./routes/taxiPathRouter");
const port = 3000;

require("dotenv").config();

const server = async () => {
  try {
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use("/taxiRoute", taxiPathRouter);

    app.listen(port, () => {
      console.log(`App listening on port ${port}`);
    });
  } catch (error) {
    console.log(error);
  }
};

server();
