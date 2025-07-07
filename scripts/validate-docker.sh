#!/bin/bash

# Docker setup validation script

set -e

echo "🔍 Validating Docker setup for Libre WebUI..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    if [ $2 -eq 0 ]; then
        echo -e "${GREEN}✅ $1${NC}"
    else
        echo -e "${RED}❌ $1${NC}"
    fi
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "ℹ️  $1"
}

# Check if Docker is installed and running
echo "Checking Docker installation..."
if command -v docker &> /dev/null; then
    print_status "Docker is installed" 0
    
    if docker ps &> /dev/null; then
        print_status "Docker daemon is running" 0
    else
        print_status "Docker daemon is not running" 1
        echo "Please start Docker daemon"
        exit 1
    fi
else
    print_status "Docker is not installed" 1
    echo "Please install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
echo ""
echo "Checking Docker Compose installation..."
if command -v docker-compose &> /dev/null; then
    print_status "Docker Compose is installed" 0
    docker-compose version
else
    print_status "Docker Compose is not installed" 1
    echo "Please install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

# Check if required files exist
echo ""
echo "Checking required files..."
files=("Dockerfile" "docker-compose.yml" "docker-compose.production.yml" ".dockerignore")
for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        print_status "$file exists" 0
    else
        print_status "$file is missing" 1
    fi
done

# Check if scripts are executable
echo ""
echo "Checking script permissions..."
if [ -f "scripts/build-docker.sh" ]; then
    if [ -x "scripts/build-docker.sh" ]; then
        print_status "build-docker.sh is executable" 0
    else
        print_warning "build-docker.sh is not executable"
        echo "Run: chmod +x scripts/build-docker.sh"
    fi
else
    print_status "build-docker.sh is missing" 1
fi

if [ -f "scripts/deploy.sh" ]; then
    if [ -x "scripts/deploy.sh" ]; then
        print_status "deploy.sh is executable" 0
    else
        print_warning "deploy.sh is not executable"
        echo "Run: chmod +x scripts/deploy.sh"
    fi
else
    print_status "deploy.sh is missing" 1
fi

# Check environment variables for production
echo ""
echo "Checking environment variables..."
if [ -n "$JWT_SECRET" ]; then
    print_status "JWT_SECRET is set" 0
else
    print_warning "JWT_SECRET is not set"
    echo "For production, set: export JWT_SECRET=\"\$(openssl rand -hex 32)\""
fi

# Validate Docker Compose files
echo ""
echo "Validating Docker Compose files..."
if docker-compose config &> /dev/null; then
    print_status "docker-compose.yml is valid" 0
else
    print_status "docker-compose.yml has errors" 1
    echo "Run: docker-compose config"
fi

if docker-compose -f docker-compose.production.yml config &> /dev/null; then
    print_status "docker-compose.production.yml is valid" 0
else
    print_status "docker-compose.production.yml has errors" 1
    echo "Run: docker-compose -f docker-compose.production.yml config"
fi

# Test Docker build (optional)
echo ""
echo "Testing Docker build..."
print_info "This will take a few minutes..."
if docker build -t libre-webui:test . &> /dev/null; then
    print_status "Docker build successful" 0
    
    # Clean up test image
    docker rmi libre-webui:test &> /dev/null
    print_info "Test image cleaned up"
else
    print_status "Docker build failed" 1
    echo "Run: docker build -t libre-webui:test ."
fi

# Summary
echo ""
echo "🎉 Validation complete!"
echo ""
echo "Next steps:"
echo "1. For development: docker-compose up -d"
echo "2. For production: Set JWT_SECRET and run ./scripts/deploy.sh"
echo "3. For GitHub Actions: Configure secrets in repository settings"
echo ""
echo "See DOCKER.md for detailed instructions."
