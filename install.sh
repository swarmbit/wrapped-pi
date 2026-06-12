#!/usr/bin/env bash 

npm run build
npm uninstall -g wpi
npm install -g .
wpi build