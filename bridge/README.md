# Qolsys PKI Bridge (homebridge-qolsys)

This bridge runs the Python `qolsys-controller` and exposes a small HTTP API for Homebridge.

## Why
Homebridge can only speak the legacy Control4 API directly. PKI/MQTT features require `qolsys-controller`, which is Python. This bridge isolates that into a local service.

## API
- `GET /health` → `{ connected, paired, panel_ip, random_mac }`
- `GET /state` → `{ partitions: [{id,name,status,secureArm}], zones: [{id,partitionId,name,type,status}] }`
- `POST /command` → arm/disarm (see payload below)

### Command payload
```json
{
  "type": "arm",
  "armingType": "ARM_AWAY" | "ARM_STAY" | "ARM_NIGHT" | "DISARM",
  "partitionId": 1,
  "delay": 120,
  "bypass": true,
  "userCode": "1234"
}
```

## Setup
```bash
cd /mnt/ssd/source/homebridge-qolsys/bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.json
# edit config.json
python3 app.py --config config.json
```

## Notes
- Pairing is handled by `qolsys-controller`. Set `start_pairing` to `true` for initial pairing.
- `config_dir` must be writable; it stores PKI keys/certs and panel state.
- Homebridge config should point `BridgeEndpoint` to this service (default `http://127.0.0.1:9123`).
