FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    moshi \
    fastapi \
    uvicorn \
    python-multipart \
    scipy

# Copy server code
COPY server.py .

EXPOSE 8201

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8201", "--device", "cuda"]
