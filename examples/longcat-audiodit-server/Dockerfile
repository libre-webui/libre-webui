FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG LONGCAT_SOURCE_COMMIT=12c76b51d2a8aa6b6c9af5b25cd5ff8f7aa8178a

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONPATH="/opt/LongCat-AudioDiT" \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LONGCAT_MODEL_ID="meituan-longcat/LongCat-AudioDiT-1B" \
    LONGCAT_DEVICE="cuda:0"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ffmpeg \
        git \
        libsndfile1 \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip \
    && pip install --requirement /app/requirements.txt

RUN git clone https://github.com/meituan-longcat/LongCat-AudioDiT.git /opt/LongCat-AudioDiT \
    && git -C /opt/LongCat-AudioDiT checkout --detach "${LONGCAT_SOURCE_COMMIT}" \
    && rm -rf /opt/LongCat-AudioDiT/.git

COPY server.py /app/server.py

EXPOSE 8300
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8300/health', timeout=3)"

CMD ["python", "/app/server.py", "--host", "0.0.0.0", "--port", "8300"]
