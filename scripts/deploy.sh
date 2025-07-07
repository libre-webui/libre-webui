#!/bin/bash

# Deployment script for libre-webui to production

set -e

echo "🚀 Deploying libre-webui to production..."

# Check if JWT_SECRET is set
if [ -z "$JWT_SECRET" ]; then
    echo "⚠️  JWT_SECRET environment variable is not set!"
    echo "Please set it with: export JWT_SECRET='your-super-secret-jwt-key'"
    exit 1
fi

# Pull latest changes (if running from git repo)
if [ -d ".git" ]; then
    echo "📥 Pulling latest changes..."
    git pull origin main
fi

# Stop existing services
echo "🛑 Stopping existing services..."
docker-compose -f docker-compose.production.yml down

# Build new image
echo "🏗️  Building new image..."
docker build -t libre-webui:latest .

# Start services
echo "🚀 Starting services..."
docker-compose -f docker-compose.production.yml up -d

# Wait for services to be ready
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check if services are running
if docker-compose -f docker-compose.production.yml ps | grep -q "Up"; then
    echo "✅ Deployment successful!"
    echo ""
    echo "Services running:"
    docker-compose -f docker-compose.production.yml ps
    echo ""
    echo "🌐 Application should be available at: https://lwui.org"
else
    echo "❌ Deployment failed!"
    echo "Check logs with: docker-compose -f docker-compose.production.yml logs"
    exit 1
fi
