FROM python:3.12-slim-trixie AS tools
ARG KUBECTL_VERSION
ARG TARGETARCH=amd64
COPY build-tools.sh /tmp/build-tools.sh
RUN sh /tmp/build-tools.sh "$KUBECTL_VERSION" "$TARGETARCH"

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libpsl5t64 libnghttp2-14 libidn2-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home candidate \
    && find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +
COPY --from=tools /out/curl /out/kubectl /usr/local/bin/
COPY --from=tools /out/tool-versions.json /usr/local/share/uniqassess/tool-versions.json
RUN curl --version && kubectl version --client
COPY workspace/workspace.py workspace/app.py /opt/lab/
COPY exercises/kubernetes-troubleshooting-v1/README.md /opt/lab/brief.md
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/workspace KUBECONFIG=/tmp/kubeconfig
WORKDIR /workspace
USER 10001:10001
CMD ["python", "/opt/lab/workspace.py"]
