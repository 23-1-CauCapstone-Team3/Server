const { Router } = require("express");
const { findTaxiPath } = require("../controllers/taxiPath-ctrl");

const taxiPathRouter = Router();

// 전체 folder 읽기
taxiPathRouter.get("/findTaxiPath", findTaxiPath);

module.exports = { taxiPathRouter };
