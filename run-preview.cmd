@echo off
cd /d C:\Users\jonat\Desktop\buildabot
set PATH=C:\Program Files\nodejs;%PATH%
node node_modules\vite\bin\vite.js preview --port 5188 --strictPort
