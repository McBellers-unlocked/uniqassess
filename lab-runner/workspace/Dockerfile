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
    && useradd --uid 10001 --create-home candidate
COPY workspace/workspace.py workspace/app.py /opt/lab/
COPY exercises/kubernetes-troubleshooting-v1/README.md /opt/lab/brief.md
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/workspace KUBECONFIG=/tmp/kubeconfig
WORKDIR /workspace
USER 10001:10001
CMD ["python", "/opt/lab/workspace.py"]
