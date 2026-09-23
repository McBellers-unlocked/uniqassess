FROM python:3.12-slim-bookworm
ARG KUBECTL_VERSION
ARG TARGETARCH=amd64
RUN test -n "$KUBECTL_VERSION" \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl \
    && curl -fsSLo /tmp/kubectl.sha256 https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256 \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check \
    && chmod 0755 /usr/local/bin/kubectl \
    && rm -rf /var/lib/apt/lists/* /tmp/kubectl.sha256 \
    && useradd --uid 10001 --create-home broker \
    && mkdir /data && chown 10001:10001 /data
WORKDIR /opt/broker
COPY runner.py manifests.py janitor.py ./
COPY exercises ./exercises
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8080
CMD ["python", "runner.py"]
