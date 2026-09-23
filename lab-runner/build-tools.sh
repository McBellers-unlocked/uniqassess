#!/bin/sh
# Build tools in a disposable stage; no compiler or vulnerable distro curl is
# copied into the final image. Revisit the pinned curl release during maintenance.
set -eu
KUBECTL_VERSION=$1
TARGETARCH=$2
export KUBECTL_VERSION TARGETARCH
export DEBIAN_FRONTEND=noninteractive
test -n "$KUBECTL_VERSION"
apt-get update
apt-get upgrade -y
apt-get install -y --no-install-recommends build-essential pkg-config ca-certificates xz-utils libssl-dev libpsl-dev zlib1g-dev libnghttp2-dev libidn2-dev
mkdir -p /out /tmp/curl-source
python - <<'PY'
import hashlib,json,os,pathlib,urllib.request
version='8.22.0'
checksum='f7ef3ae8a22e521f289803fe93543eb64c329b58aa73a9e224dfd915a2a5f4f7'
archive=pathlib.Path('/tmp/curl.tar.xz')
urllib.request.urlretrieve(f'https://curl.se/download/curl-{version}.tar.xz',archive)
assert hashlib.sha256(archive.read_bytes()).hexdigest()==checksum,'curl source checksum mismatch'
base=f'https://dl.k8s.io/release/{os.environ["KUBECTL_VERSION"]}/bin/linux/{os.environ["TARGETARCH"]}/kubectl'
binary=pathlib.Path('/out/kubectl')
urllib.request.urlretrieve(base,binary)
with urllib.request.urlopen(base+'.sha256') as response: expected=response.read().decode().strip()
assert hashlib.sha256(binary.read_bytes()).hexdigest()==expected,'kubectl checksum mismatch'
binary.chmod(0o755)
pathlib.Path('/out/tool-versions.json').write_text(json.dumps({'curl':version,'curlSourceSha256':checksum,'kubectl':os.environ['KUBECTL_VERSION'],'kubectlSha256':expected}))
PY
tar -xJf /tmp/curl.tar.xz --strip-components=1 -C /tmp/curl-source
cd /tmp/curl-source
./configure --prefix=/opt/curl --disable-shared --enable-static --with-openssl --with-libpsl --with-zlib --with-nghttp2 --with-libidn2 --without-brotli --without-zstd
make -j2
make install
install -m 0755 /opt/curl/bin/curl /out/curl
/out/curl --version
