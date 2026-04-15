require("dotenv").config(); // 加载环境变量

const config = {
  PORT: process.env.PORT || 3000,
  PYTHON_API_URL: process.env.PYTHON_API_URL || "http://127.0.0.1:8000",
};

module.exports = config;
