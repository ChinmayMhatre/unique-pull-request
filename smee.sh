#!/bin/bash

# Ensure smee-client is installed globally or locally
if ! command -v npx &> /dev/null
then
    echo "npm/npx could not be found. Please install Node.js."
    exit 1
fi

echo "🚀 Starting Smee Proxy for Local Webhooks..."
echo "Ensure your GitHub App is configured with this smee URL."
echo "Listening and forwarding to http://localhost:3000/api/github/webhooks"
echo "---"

# Replace the URL below with the persistent Smee URL you generated
npx smee-client -u https://smee.io/{yourlink} -t http://localhost:3000/api/github/webhooks
