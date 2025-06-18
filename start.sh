#!/bin/bash

# Libre WebUI Startup Script
echo "🚀 Starting Libre WebUI..."

# Load environment variables from backend/.env if it exists
if [ -f "backend/.env" ]; then
    export $(grep -v '^#' backend/.env | xargs)
fi

# Set default Ollama URL if not set
OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-"http://localhost:11434"}

# Function to check if a port is in use
check_port() {
    lsof -i :$1 > /dev/null 2>&1
}

# Function to wait for a service to start
wait_for_service() {
    local url=$1
    local service_name=$2
    echo "⏳ Waiting for $service_name to start..."
    for i in {1..30}; do
        if curl -s "$url" > /dev/null 2>&1; then
            echo "✅ $service_name is running"
            return 0
        fi
        sleep 1
    done
    echo "❌ $service_name failed to start within 30 seconds"
    return 1
}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install it first:"
    echo "   Visit: https://nodejs.org"
    exit 1
fi

# Check if Ollama is accessible (local or remote)
echo "🔍 Testing connection to Ollama at: $OLLAMA_BASE_URL"
if curl -s "$OLLAMA_BASE_URL/api/tags" > /dev/null 2>&1; then
    echo "✅ Ollama is accessible at: $OLLAMA_BASE_URL"
    
    # Check if models are available (works for both local and remote)
    models=$(curl -s "$OLLAMA_BASE_URL/api/tags" 2>/dev/null | jq -r '.models | length' 2>/dev/null || echo "0")
    if [ "$models" -eq 0 ] || [ "$models" = "null" ]; then
        echo "⚠️  No models found on Ollama instance."
        echo "   To install models on your Ollama instance, run:"
        echo "   ollama pull llama3.2:1b  # or another model"
    else
        echo "✅ Found $models model(s) on Ollama instance"
    fi
else
    echo "❌ Cannot connect to Ollama at: $OLLAMA_BASE_URL"
    echo "   Please ensure Ollama is running and accessible."
    echo "   If using a remote Ollama, check your network connectivity."
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing root dependencies..."
    npm install
fi

if [ ! -d "backend/node_modules" ]; then
    echo "📦 Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "📦 Installing frontend dependencies..."
    cd frontend && npm install && cd ..
fi

# Check if ports are already in use
if check_port 3001; then
    echo "⚠️  Port 3001 is already in use (backend)"
    echo "   You can kill the process with: lsof -ti:3001 | xargs kill -9"
fi

if check_port 5173; then
    echo "⚠️  Port 5173 is already in use (frontend)"
    echo "   You can kill the process with: lsof -ti:5173 | xargs kill -9"
fi

# Start the backend
echo "🔧 Starting backend server..."
cd backend
nohup npm run dev > ../backend.log 2>&1 &
BACKEND_PID=$!
cd ..

# Start the frontend
echo "🔧 Starting frontend server..."
cd frontend
nohup npm run dev > ../frontend.log 2>&1 &
FRONTEND_PID=$!
cd ..

# Wait for services to start
wait_for_service "http://localhost:3001/api/ollama/health" "Backend API"
wait_for_service "http://localhost:5173" "Frontend"

echo ""
echo "✅ Libre WebUI is now running!"
echo ""
echo "🌐 Access the application:"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3001"
echo ""
echo "📋 Service Status:"
if curl -s "$OLLAMA_BASE_URL/api/tags" > /dev/null 2>&1; then
    echo "   ✅ Ollama:    $OLLAMA_BASE_URL"
else
    echo "   ❌ Ollama:    $OLLAMA_BASE_URL (not accessible)"
fi
if check_port 3001; then
    echo "   ✅ Backend:   http://localhost:3001"
else
    echo "   ❌ Backend:   Failed to start (check backend.log)"
fi
if check_port 5173; then
    echo "   ✅ Frontend:  http://localhost:5173"
else
    echo "   ❌ Frontend:  Failed to start (check frontend.log)"
fi
echo ""
echo "📄 Logs:"
echo "   Backend:  tail -f backend.log"
echo "   Frontend: tail -f frontend.log"
echo ""
echo "🛑 To stop services:"
echo "   kill $BACKEND_PID $FRONTEND_PID"
echo "   or run: pkill -f 'npm run dev'"
