FROM python:3.12-alpine
WORKDIR /app
COPY server.py ripples.py ./
ENV HOST=0.0.0.0 PORT=8095
USER 65534:65534
EXPOSE 8095
CMD ["python", "server.py"]
