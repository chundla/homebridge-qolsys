
# Homebridge Plugin for Qolsys Panels
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![npm downloads](https://badgen.net/npm/dt/homebridge-qolsys)](https://www.npmjs.com/package/homebridge-qolsys)

This plugin supports two transport modes:

- **Control4 (legacy)**: basic security features only.
- **MQTT Bridge (recommended)**: full state sync + automation devices via `qolsys-controller`.

| Feature | Control4 | MQTT Bridge |
| --- | --- | --- |
| Arming/Disarming | ✅ | ✅ |
| RF + wired sensors | ✅ | ✅ |
| Z‑Wave automation devices (locks/lights/thermostat/cover/siren/valve) | ❌ | ✅ |
| IQ Panel smart home features | ❌ | ✅ (via automation devices) |
| Alarm.com cloud features | ❌ | ❌ |
 
## Supported Qolsys Panels
| Panel  | Status | Notes |
| ------ | ------ |  ------ |
| [IQ](https://qolsys.com/iq-panel/) | Not Supported|  |
| [IQ HUB](https://qolsys.com/iq4-hub/) |Not Supported |  |
| [IQ2](https://qolsys.com/iq-panel-2/) | Supported | Software >= 2.4.0, >= 2.6.2: Enable 6-digit user codes |
| [IQ2+](https://qolsys.com/iq-panel-2-plus/) | Supported| Software >= 2.6.2: Enable 6-digit user codes |
| [IQ4](https://qolsys.com/iq-panel-4/) | Supported | Software >= 4.1.0,  >= 4.2.0: Enable 6-digit user codes |
| [IQ4 HUB](https://qolsys.com/iq4-hub/) | Status Pending (assumed same support as IQ4) |  |
| [IQ4 NS](https://qolsys.com/iq4-ns/) | Status Pending (assumed same support as IQ4) | (Requires companion app to setup)  |
| [IQ Pro](https://qolsys.com/iq-pro/) | Status Pending (assumed same support as IQ4) | (Requires companion app to setup) |


## Supported Sensors
- Motion and Panel Motion
- Door, Window, Tilt
- Water
- Heat, Freeze
- Smoke Detector
- CO Detector
- Glass Break and Panel Glass Break
- IQ Doorbell sensor

## Supported Automation Devices (MQTT Bridge)
- Locks
- Lights (on/off + level)
- Thermostats (mode + setpoints + fan)
- Covers/garage doors
- Sirens
- Valves

## Homebridge Plugin Configuration
### MQTT Bridge Overview
When `TransportMode = mqtt`, Homebridge talks to the controller bridge topics under `qolsys_panel/v1/home/...` by default.
The controller bridge publishes panel state, partition state, zone state, and automation-device state from the same root.

Supported MQTT bridge capabilities:
- Panel status/settings + panel commands
- Partition state + arming/disarming commands
- Zone state for motion, contact, water, heat/freeze, smoke, CO, glass break, and doorbell sensors
- Automation devices for locks, lights, thermostats, covers/garage doors, sirens, and valves

Configuration keys used by the bridge path:
- `MqttBridgeRootTopic`: bridge root topic (default `qolsys`)
- `MqttCaPath`: CA certificate path for the controller bridge
- `BridgeEndpoint`: HTTP endpoint used for CA bootstrap and health checks
- `MqttUrl`: MQTT broker URL used by the controller bridge
- `MqttUsername` / `MqttPassword`: broker auth if enabled
- `MqttClientId`: must be unique per broker

### General Parameters
* `Host`:  Qolsys Panel IP address
* `Port`:  Qolsys Panel Port number (defaults to 12345)
* `Secure Token`: C4 Integration Secure Token (Control4 mode)
* `User Pin Code`: User security code
* `Arm Away Exit Delay`: How much time users have to exit the location before the panel arms itself to Arm Away (0 sec or any number higher than your panel long exit delay (120 sec by default))
* `Arm Stay Exit Delay`: How much time before the panel arms itself to Arm Stay (0 sec or any number higher than your panel long exit delay (120 sec by default))
* `Force Arm`: Bypass open or faulted sensors when arming partition

### Transport Options
* `TransportMode`: `c4` (legacy) or `mqtt` (MQTT Bridge)
* `MqttUrl`: MQTT broker URL used by the controller bridge (default `mqtt://127.0.0.1:1883`)
* `MqttUsername`: MQTT broker username (optional)
* `MqttPassword`: MQTT broker password (optional)
* `MqttClientId`: MQTT client id (must be unique per broker)
* `MqttBridgeRootTopic`: MQTT bridge root topic (default `qolsys`)
* `MqttCaPath`: CA certificate path for the MQTT bridge
* `BridgeEndpoint`: HTTP endpoint used for CA bootstrap and health checks (default `http://127.0.0.1:9123`)

### Motion Sensors
As of version 0.4, Qolsys motion sensors can now be presented as motion or occupancy sensors with a user selectable option in Homebridge UI. The available options are:
- Motion sensor only
- Occupancy sensor only
- Motion and occupancy sensors

*** Upgrade to version 0.4 may be disruptive for established automations using motion sensors

## Qolsys Panel Configuration
Prerequsite: On the latest Qolsys firmwaare 6 digit PIN codes must be enabled.

### MQTT Bridge (recommended)
Homebridge connects to an MQTT broker and consumes `qolsys-controller` bridge topics under `<root>/v1/home/...`.
By default that is `qolsys/v1/home/...`, and the controller side publishes the same root plus friendly name namespace.
Commands are published back on the matching bridge topics. Keep `MqttBridgeRootTopic` aligned with the controller bridge root.

**Broker quick start (Debian/Ubuntu):**
```bash
sudo apt-get update && sudo apt-get install -y mosquitto mosquitto-clients
sudo systemctl enable --now mosquitto
```

**qolsys-controller bridge (CLI):**
```bash
python3 bin/qolsys.py \
  --panel-ip <PANEL_IP> \
  --plugin-ip <HOST_IP> \
  --config-dir <CONFIG_DIR> \
  --random-mac <PAIRED_RANDOM_MAC> \
  --mqtt-bridge \
  --mqtt-bridge-url mqtt://127.0.0.1:1883
```

**Startup order:** start qolsys-controller **before** Homebridge so the MQTT bridge is already connected.

### Legacy PKI Bridge Setup
A local bridge service can still expose the older HTTP API for the legacy PKI transport.
See `bridge/README.md` for setup, pairing, and config.

#### PKI Bridge Requirements
- **Python 3** (3.9+ recommended)
- **Python venv module** (needed for `python3 -m venv`)
- **pip** (for installing bridge deps)

> Debian/Ubuntu: `python3`, `python3-venv`, `python3-pip`
- Settings
- Advanced Settings
- Enter Dealer Code (defaults to 2222)
- Installation
- Dealer Settings
- 6 Digit User Code
Once enabled all existing codes will have 00 appended.

### IQ2, IQ2+ and IQ4
1. Start by enabling Control 4 integration on Qolsys panel:
- Settings
- Advanced Settings 
- Enter Dealer Code (defaults to 2222 or 222200)
- Installation
- Devices
- WIFI Devices
- 3rd Party Connections
- Check the Control4 box
- Reboot Qolsys Panel

2. Reveal Secure Access Token:
- Settings
- Advanced Settings 
- Enter Dealer Code (defaults to 2222 or 222200)
- Installation
- Devices
- WIFI Devices
- 3rd Party Connections
- Select Reveal Secure Token field

### Timing Note 
Once Control 4 is enabled you have **10 minutes** to view the access token, configure the plugin, and have it make it's initial connection to the panel. If no connection is made in this time the panel will disable the Control 4 integration and reboot. (This behavior may be firmware dependent)

## Plugin Operation
### HomeKit Security System Accessory:
| Homekit Partition State | Qolsys Partition State|
| ------ | ------ | 
| Off | Disarmed
| Away | Arm Away, Exit Delay in config file
| Home | Arm Stay, Exit Delay in config file

### MQTT Bridge (automation)
When `TransportMode = mqtt`, Homebridge talks to the controller bridge topics under `<MqttBridgeRootTopic>/v1/home/...`.
This enables automation devices (locks, lights, thermostat, cover/garage, siren, valve) in HomeKit, plus live zone and partition state sync.

`BridgeEndpoint` is only used for CA bootstrap and health checks.

### Arming Limitations
The Control4 interface on the IQ panels is intended as a local integration for Control4 remotes, as such this integration acts as a 'local' keypad. This means that when arming Away, by **default**, if no perimiter doors are opened the Auto Stay setting will trigger and the arming state will switch to Stay (Home). This setting can be disabled globally in the IQ panel, however disabling it increases the risk of triggereing alarms in the event Away is accidentaly selected while at home.

By **default** the IQ panels don't support directly transitioning from one armed state to another, you must first Disarm(Off) before you can arm as Stay(Home) or Away.
The plugin supports direct transions with the following configurations:
- If Arm Away Exit Delay is set to 0, panel will allow a direct transition from Arm_Stay to Arm_Away
- If Arm Stay Exit Delay is set to 0, panel will allow a direct transition from Arm_Amay to Arm_Stay 

### Tips
There are a few things to be aware of regarding how HomeKit currently (iOS 16.0) represents security sensors.
If a room only contains sensors, and no controllable devices, it won't display the room in the Home View. This includes the Default room created for newly added devices after initial bridge enrollment. Such rooms are still selectable from the list of rooms to view. When viewing any specific room you can see its associated sensors. A summary of all currently triggered sensors will be displayed when the Security category is selected in Home View. Sensors that aren't triggered won't display in the summary, so if you have no activity the summary will be empty. This behaviour is different from the summarys for Lights or Speakers & TV, which will show devices independent of state.  When viwing the Security Summary, if multiple sensors of the same type are triggered selecting the sensor type will show a list of the triggered sensors. 

If you add sensors after the initial enrollment of the hub they will be added to a room named Default. For this reason it is generally a good idea to either add the HomeBridge to HomeKit after configuration of the plugin OR run the plugin as a child bridge and add it to HomeKit after you have confirmed proper configuration. The advantage of this approach is that when the bridge is added after the plugin is configured, HomeKit will present dialogs for each sensor allowing correct placement in each room as well as selection of display icon. While tedious, this approach is a simpler process to assign sensors to the correct room. If you don't follow this approach or add sensors later, they will be added to the Default room with default icon representation. Sensors can be moved to a different room, and the representative icon change, from the Settings similar to any other HomeKit device. The easist way to find any errant sensors is "Home Settings" -> "Home Hubs & Bridges" -> select either Homebridge or the Qolsys child bridge -> Accessories, this provides a view of all sensors that are directly part of the bridge. 

Flood sensors currently (iOS 16.0) have behavior distinct from other security sensors. When a flood sensor is enrolled, a new Summary Group for Water will be displayed in the Home View. Similar to Security Summary, when selected the summary view for water won't display any information about the flood sensors unless there is an active alert.

## Credits
- @andrewfblack, @CodyRWhite, @ifeign and @siglumous for beta testing initial plugin versions!
- [Home Assistant support thread](https://community.home-assistant.io/t/qolsys-iq-panel-2-and-3rd-party-integration/231405)
- [Don Caton @dcaton Hubitat-QolSysIQPanel plugin](https://github.com/dcaton/Hubitat/tree/main/QolSysIQPanel)
