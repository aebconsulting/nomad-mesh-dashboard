# --- build stage: node exists ONLY here ---
FROM node:20-slim AS webbuild
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime: python only ---
FROM python:3.12-slim
LABEL org.opencontainers.image.source=https://github.com/aebconsulting/nomad-mesh-dashboard
LABEL org.opencontainers.image.description="Offline-first web dashboard for a Meshtastic mesh (companion to mesh-ai-bridge)"
LABEL org.opencontainers.image.licenses=MIT
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app.py .
COPY --from=webbuild /web/dist ./static
ENV STATIC_DIR=/app/static
USER 1000:20
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
