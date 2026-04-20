const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");

const SDK = require("@superdoc-dev/sdk");

console.log("SDK 导出:", Object.keys(SDK));