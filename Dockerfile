FROM node:22-alpine AS base
 
# Install security updates
RUN apk update && apk upgrade && apk add --no-cache dumb-init

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat python3 make g++ git && \
    apk update && apk upgrade
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Copy git hooks directory (needed for postinstall)
COPY .githooks/ ./.githooks/

# Initialize git repository for postinstall script
RUN git init && git config user.email "docker@example.com" && git config user.name "Docker Build"

# Install all dependencies (including dev dependencies for building)
RUN npm ci && npm cache clean --force

# Install production dependencies only
FROM base AS prod-deps
RUN apk add --no-cache libc6-compat python3 make g++ git && \
    apk update && apk upgrade
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Copy git hooks directory (needed for postinstall)
COPY .githooks/ ./.githooks/

# Initialize git repository for postinstall script
RUN git init && git config user.email "docker@example.com" && git config user.name "Docker Build"

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Build frontend
FROM base AS frontend-builder
RUN apk add --no-cache libc6-compat python3 make g++ git && \
    apk update && apk upgrade
WORKDIR /app

# Copy package files for workspace setup
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Copy git hooks directory (needed for postinstall)
COPY .githooks/ ./.githooks/

# Initialize git repository for postinstall script
RUN git init && git config user.email "docker@example.com" && git config user.name "Docker Build"

# Install dependencies in workspace
RUN npm ci && npm cache clean --force

# Copy frontend source code
COPY frontend/ ./frontend/

# Set production environment variables for frontend build
# Use window.location.origin + port to connect to backend on same host
ENV VITE_API_BASE_URL=""
ENV VITE_API_URL=""

RUN cd frontend && npm run build

# Build backend
FROM base AS backend-builder
RUN apk add --no-cache libc6-compat python3 make g++ git && \
    apk update && apk upgrade
WORKDIR /app

# Copy package files for workspace setup
COPY package*.json ./
COPY frontend/package*.json ./frontend/
COPY backend/package*.json ./backend/

# Copy git hooks directory (needed for postinstall)
COPY .githooks/ ./.githooks/

# Initialize git repository for postinstall script
RUN git init && git config user.email "docker@example.com" && git config user.name "Docker Build"

# Install dependencies in workspace
RUN npm ci && npm cache clean --force

# Copy backend source code
COPY backend/ ./backend/

RUN cd backend && npm run build

# Production image
FROM base AS runner
WORKDIR /app

# Install security updates
RUN apk update && apk upgrade && apk add --no-cache wget

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nodejs

# Copy built application
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY --from=backend-builder /app/backend/dist ./backend/dist
COPY --from=backend-builder /app/backend/package*.json ./backend/
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package*.json ./

# Copy plugins directory
COPY plugins ./plugins

# Install serve for frontend static file serving
RUN npm install -g serve

# Create directories for data persistence
RUN mkdir -p ./backend/data && \
    mkdir -p ./backend/temp && \
    mkdir -p ./plugins && \
    mkdir -p ./uploads && \
    chown -R nodejs:nodejs /app

# Create startup script that runs both services
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'echo "Starting frontend server on port $FRONTEND_PORT..."' >> /app/start.sh && \
    echo 'serve -s ./frontend/dist -l tcp://0.0.0.0:$FRONTEND_PORT &' >> /app/start.sh && \
    echo 'echo "Starting backend server on port 3001..."' >> /app/start.sh && \
    echo 'node ./backend/dist/index.js' >> /app/start.sh && \
    chmod +x /app/start.sh && \
    chown nodejs:nodejs /app/start.sh

# Switch to non-root user
USER nodejs

# Set production environment
ENV NODE_ENV=production
ENV PORT=3001
ENV FRONTEND_PORT=5173

# Set Ollama URL to connect to host machine when running in container
ENV OLLAMA_BASE_URL=http://host.docker.internal:11434

# JWT secret should be provided at runtime via environment variable or Docker secrets
# Do not set JWT_SECRET here - it will be generated automatically if not provided

# Expose ports - 3001 for backend, 5173 for frontend
EXPOSE 3001 5173

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start both services
CMD ["/app/start.sh"]
