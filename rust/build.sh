#!/bin/sh
set -e
cd "$(dirname "$0")"
CARGO_TARGET_DIR=target-next cargo build --release
mkdir -p target/release
cp target-next/release/tower target/release/tower.next
mv -f target/release/tower.next target/release/tower
