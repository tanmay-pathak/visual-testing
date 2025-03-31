#!/bin/bash

# Check if a preview domain was provided
if [ $# -eq 0 ]; then
  echo "Usage: ./run-visual-comparison.sh <preview-domain>"
  echo "Example: ./run-visual-comparison.sh deploy-preview-320--zuc-web.netlify.app"
  exit 1
fi

# Export the preview domain as an environment variable
export PREVIEW_DOMAIN=$1

echo "Starting visual testing with Deno and Browserless..."
echo "Preview domain: $PREVIEW_DOMAIN"

# Run docker-compose
docker-compose up --build

# Print output location info
echo "Visual comparison completed."
echo "Screenshots are in the 'screenshots' directory."
echo "Diff images are in the 'changes' directory." 