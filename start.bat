@echo off
title freeseek - Local DeepSeek OpenAI Proxy
echo Starting freeseek local proxy...
node bin/freeseek.js
if %errorlevel% neq 0 (
  echo.
  echo Node.js is required to run freeseek.
  echo Please install Node.js from https://nodejs.org/
  pause
)
