FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY static ./static
RUN mkdir -p /data
# SQLite file lives on a mounted volume at /data unless DATABASE_URL points at Postgres.
ENV BOARD_DB=/data/boards.db PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "python -m uvicorn server.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
