FROM python:3.12-slim-trixie AS tools
ARG KUBECTL_VERSION
ARG TARGETARCH=amd64
COPY build-tools.sh /tmp/build-tools.sh
RUN sh /tmp/build-tools.sh "$KUBECTL_VERSION" "$TARGETARCH"

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libpsl5t64 libnghttp2-14 libidn2-0 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home broker \
    && mkdir /data && chown 10001:10001 /data \
    && find /usr -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +
COPY --from=tools /out/curl /out/kubectl /usr/local/bin/
COPY --from=tools /out/tool-versions.json /usr/local/share/uniqassess/tool-versions.json
RUN curl --version && kubectl version --client
WORKDIR /opt/broker
COPY runner.py manifests.py janitor.py ./
COPY exercises ./exercises
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8080
CMD ["python", "runner.py"]
