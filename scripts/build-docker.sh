#!/bin/bash

# Build and deploy script for libre-webui

set -e

echo "🏗️  Building libre-webui Docker image..."

# Build the Docker image
docker build -t libre-webui:latest .

echo "✅ Docker image built successfully!"

# Tag for deployment
docker tag libre-webui:latest libre-webui:$(date +%Y%m%d-%H%M%S)

echo "🏷️  Image tagged with timestamp"

# Optional: Push to registry if DOCKER_REGISTRY is set
if [ ! -z "$DOCKER_REGISTRY" ]; then
    echo "📤 Pushing to registry: $DOCKER_REGISTRY"
    docker tag libre-webui:latest $DOCKER_REGISTRY/libre-webui:latest
    docker push $DOCKER_REGISTRY/libre-webui:latest
    echo "✅ Image pushed to registry"
fi

echo "🎉 Build completed successfully!"
echo ""
echo "To run locally:"
echo "  docker-compose up -d"
echo ""
echo "To run in production:"
echo "  docker-compose -f docker-compose.production.yml up -d"
