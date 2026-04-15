const express = require("express");
const router = express.Router();
const { runAgentStream } = require("../services/aiServices");

router.post("/agent/run/stream", runAgentStream);

module.exports = router;
