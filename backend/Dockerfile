FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip
RUN pip install --upgrade pip

# Copy requirements
COPY requirements-base.txt ./

# Install backend runtime dependencies without the legacy heavy ML stack.
RUN pip install --no-cache-dir -r requirements-base.txt

# Install PyTorch CPU version
RUN pip install --no-cache-dir torch==2.2.0 torchaudio==2.2.0 --index-url https://download.pytorch.org/whl/cpu

# Install whisper from git (avoids build issues)
RUN pip install --no-cache-dir "openai-whisper @ git+https://github.com/openai/whisper.git"

# Install pyannote.audio
RUN pip install --no-cache-dir pyannote.audio==3.1.1

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
