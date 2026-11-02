# Home Assistant app: the dtaluchs image plus a start script.
# The Supervisor builds it on the device and passes BUILD_VERSION, the value of version in config.yaml.
ARG BASE_IMAGE=ghcr.io/siedi/dtaluchs
ARG BUILD_VERSION
FROM ${BASE_IMAGE}:${BUILD_VERSION}
# root only for run.py: it takes over /data and starts the server as UID 10001
USER root
COPY run.py /app/ha/run.py
CMD ["python", "/app/ha/run.py"]
