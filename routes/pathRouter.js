const { Router } = require("express");
const { findPath } = require("../controllers/path-ctrl");
pathRouter = Router()

pathRouter.get('/getLastTimeAndPath', findPath)

module.exports = { pathRouter };
