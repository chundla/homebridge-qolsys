#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import signal
import socket
from dataclasses import dataclass
from typing import Any

from aiohttp import web
from qolsys_controller import qolsys_controller
from qolsys_controller.enum import (
    PartitionAlarmState,
    PartitionAlarmType,
    PartitionArmingType,
    PartitionSystemStatus,
    ZoneStatus,
    ZoneSensorType,
    QolsysHvacMode,
    QolsysFanMode,
)
from qolsys_controller.automation.service_light import LightService
from qolsys_controller.automation.service_lock import LockService
from qolsys_controller.automation.service_cover import CoverService
from qolsys_controller.automation.service_siren import SirenService
from qolsys_controller.automation.service_valve import ValveService
from qolsys_controller.automation.service_thermostat import ThermostatService
from qolsys_controller.errors import QolsysUserCodeError, QolsysMqttError, QolsysSslError


@dataclass
class BridgeConfig:
    panel_ip: str
    panel_mac: str
    random_mac: str
    config_dir: str
    plugin_ip: str | None
    auto_discover_pki: bool
    start_pairing: bool
    check_user_code_on_arm: bool
    check_user_code_on_disarm: bool
    log_mqtt_messages: bool
    http_host: str
    http_port: int


def _detect_local_ip() -> str:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return "127.0.0.1"


def load_config(path: str) -> BridgeConfig:
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)

    return BridgeConfig(
        panel_ip=raw["panel_ip"],
        panel_mac=raw["panel_mac"],
        random_mac=raw["random_mac"],
        config_dir=raw.get("config_dir", "/var/lib/qolsys-bridge"),
        plugin_ip=raw.get("plugin_ip"),
        auto_discover_pki=bool(raw.get("auto_discover_pki", False)),
        start_pairing=bool(raw.get("start_pairing", False)),
        check_user_code_on_arm=bool(raw.get("check_user_code_on_arm", False)),
        check_user_code_on_disarm=bool(raw.get("check_user_code_on_disarm", False)),
        log_mqtt_messages=bool(raw.get("log_mqtt_messages", False)),
        http_host=raw.get("http_host", "0.0.0.0"),
        http_port=int(raw.get("http_port", 9123)),
    )


def map_partition_status(partition) -> str:
    # Alarm overrides system status
    if partition.alarm_state == PartitionAlarmState.ALARM:
        alarm_types = {alarm.value for alarm in partition.alarm_type_array}
        if PartitionAlarmType.FIRE_EMERGENCY.value in alarm_types:
            return "ALARM_FIRE"
        if PartitionAlarmType.AUXILIARY_EMERGENCY.value in alarm_types or PartitionAlarmType.SILENT_AUXILIARY_EMERGENCY.value in alarm_types:
            return "ALARM_AUXILIARY"
        return "ALARM_POLICE"

    status = partition.system_status
    if status == PartitionSystemStatus.ARM_STAY:
        return "ARM_STAY"
    if status == PartitionSystemStatus.ARM_AWAY:
        return "ARM_AWAY"
    if status == PartitionSystemStatus.ARM_NIGHT:
        return "ARM_STAY"
    if status == PartitionSystemStatus.ARM_AWAY_EXIT_DELAY:
        return "ARM-AWAY-EXIT-DELAY"
    if status == PartitionSystemStatus.ARM_STAY_EXIT_DELAY:
        return "ARM-STAY-EXIT-DELAY"
    if status == PartitionSystemStatus.ARM_NIGHT_EXIT_DELAY:
        return "ARM-STAY-EXIT-DELAY"
    if status == PartitionSystemStatus.DISARM:
        return "DISARM"

    return "DISARM"


def map_zone_type(sensor_type: ZoneSensorType | str) -> str:
    value = sensor_type.value if isinstance(sensor_type, ZoneSensorType) else str(sensor_type)

    mapping = {
        ZoneSensorType.DOOR_WINDOW.value: "Door_Window",
        ZoneSensorType.DOOR_WINDOW_M.value: "Door_Window",
        ZoneSensorType.GLASS_BREAK.value: "GlassBreak",
        ZoneSensorType.PANEL_GLASS_BREAK.value: "Panel Glass Break",
        ZoneSensorType.MOTION.value: "Motion",
        ZoneSensorType.PANEL_MOTION.value: "Panel Motion",
        ZoneSensorType.SMOKE_DETECTOR.value: "SmokeDetector",
        ZoneSensorType.SMOKE_M.value: "Smoke_M",
        ZoneSensorType.CO_DETECTOR.value: "CODetector",
        ZoneSensorType.WATER.value: "Water",
        ZoneSensorType.AUXILIARY_PENDANT.value: "AuxiliaryPendant",
        ZoneSensorType.BLUETOOTH.value: "Bluetooth",
        ZoneSensorType.KEYPAD.value: "Keypad",
        ZoneSensorType.TAKEOVER_MODULE.value: "TakeoverModule",
        ZoneSensorType.TILT.value: "Tilt",
        ZoneSensorType.KEY_FOB.value: "KeyFob",
        ZoneSensorType.FREEZE.value: "Freeze",
        ZoneSensorType.HEAT.value: "Heat",
        ZoneSensorType.HIGH_TEMPERATURE.value: "Heat",
        ZoneSensorType.DOORBELL.value: "Doorbell",
    }

    return mapping.get(value, "Unknown")


def map_zone_status(zone_status: ZoneStatus | str) -> str:
    value = zone_status.value if isinstance(zone_status, ZoneStatus) else str(zone_status)
    open_values = {
        ZoneStatus.OPEN.value,
        ZoneStatus.ACTIVE.value,
        ZoneStatus.ACTIVATED.value,
        ZoneStatus.ALARMED.value,
        ZoneStatus.TAMPERED.value,
        ZoneStatus.TROUBLE.value,
        ZoneStatus.OCCUPIED.value,
    }
    return "Open" if value in open_values else "Closed"


class QolsysBridge:
    def __init__(self, config: BridgeConfig, log: logging.Logger) -> None:
        self.config = config
        self.log = log
        self.controller = qolsys_controller()
        self._app = web.Application()
        self._runner: web.AppRunner | None = None

    async def start(self) -> None:
        os.makedirs(self.config.config_dir, exist_ok=True)

        settings = self.controller.settings
        settings.config_directory = self.config.config_dir
        settings.plugin_ip = self.config.plugin_ip or _detect_local_ip()
        settings.panel_ip = self.config.panel_ip
        settings.panel_mac = self.config.panel_mac
        settings.random_mac = self.config.random_mac
        settings.log_mqtt_messages = self.config.log_mqtt_messages
        settings.auto_discover_pki = self.config.auto_discover_pki
        settings.check_user_code_on_arm = self.config.check_user_code_on_arm
        settings.check_user_code_on_disarm = self.config.check_user_code_on_disarm

        configured = await self.controller.config(start_pairing=self.config.start_pairing)
        if not configured:
            raise RuntimeError("Failed to configure qolsys-controller (pairing/config issue)")

        await self.controller.start_operation()

        self._app.add_routes([
            web.get("/health", self.handle_health),
            web.get("/state", self.handle_state),
            web.post("/command", self.handle_command),
        ])

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.config.http_host, self.config.http_port)
        await site.start()
        self.log.info("Qolsys bridge listening on %s:%s", self.config.http_host, self.config.http_port)

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
        await self.controller.stop_operation()

    async def handle_health(self, request: web.Request) -> web.Response:
        payload = {
            "connected": bool(self.controller.connected),
            "paired": bool(self.controller.is_paired()),
            "panel_ip": self.config.panel_ip,
            "random_mac": self.controller.settings.random_mac or self.config.random_mac,
        }
        return web.json_response(payload)

    async def handle_state(self, request: web.Request) -> web.Response:
        partitions = []
        zones = []
        secure_arm = self.controller.panel.SECURE_ARMING == "true"

        for partition in self.controller.state.partitions:
            try:
                partition_id = int(partition.id)
            except ValueError:
                continue

            partitions.append({
                "id": partition_id,
                "name": partition.name or f"Partition {partition_id}",
                "status": map_partition_status(partition),
                "secureArm": secure_arm,
            })

        for zone in self.controller.state.zones:
            try:
                zone_id = int(zone.zone_id)
                partition_id = int(zone.partition_id or 0)
            except ValueError:
                continue

            zones.append({
                "id": zone_id,
                "partitionId": partition_id,
                "name": zone.sensorname or f"Zone {zone_id}",
                "type": map_zone_type(zone.sensortype),
                "status": map_zone_status(zone.sensorstatus),
            })

        automation_devices = []
        for device in self.controller.state.automation_devices:
            try:
                virtual_node_id = int(device.virtual_node_id)
            except (TypeError, ValueError):
                continue

            try:
                partition_id = int(device.partition_id or 0)
            except (TypeError, ValueError):
                partition_id = 0

            services: list[dict[str, Any]] = []
            for service in device.services:
                if isinstance(service, LightService):
                    services.append({
                        "type": "light",
                        "endpoint": service.endpoint,
                        "isOn": service.is_on,
                        "level": service.level,
                        "supportsLevel": service.supports_level(),
                    })
                elif isinstance(service, LockService):
                    services.append({
                        "type": "lock",
                        "endpoint": service.endpoint,
                        "isLocked": service.is_locked,
                        "isJammed": service.is_jammed,
                        "isLocking": service.is_locking,
                        "isUnlocking": service.is_unlocking,
                    })
                elif isinstance(service, CoverService):
                    services.append({
                        "type": "cover",
                        "endpoint": service.endpoint,
                        "isClosed": service.is_closed,
                        "isOpening": service.is_opening,
                        "isClosing": service.is_closing,
                        "currentPosition": service.current_position,
                        "supportsPosition": service.supports_position(),
                    })
                elif isinstance(service, SirenService):
                    services.append({
                        "type": "siren",
                        "endpoint": service.endpoint,
                        "isOn": service.is_on,
                    })
                elif isinstance(service, ValveService):
                    services.append({
                        "type": "valve",
                        "endpoint": service.endpoint,
                        "isClosed": service.is_closed,
                        "isOpening": service.is_opening,
                        "isClosing": service.is_closing,
                        "currentPosition": service.current_position,
                        "supportsPosition": service.supports_position(),
                    })
                elif isinstance(service, ThermostatService):
                    services.append({
                        "type": "thermostat",
                        "endpoint": service.endpoint,
                        "hvacMode": service.hvac_mode.value if service.hvac_mode else None,
                        "hvacModes": [mode.value for mode in service.hvac_modes] if service.hvac_modes else [],
                        "hvacAction": service.hvac_action.value if service.hvac_action else None,
                        "fanMode": service.fan_mode.value if service.fan_mode else None,
                        "fanModes": [mode.value for mode in service.fan_modes] if service.fan_modes else [],
                        "currentTemperature": service.current_temperature,
                        "currentHumidity": service.current_humidity,
                        "targetHeatTemp": service.target_heat_temp,
                        "targetCoolTemp": service.target_cool_temp,
                        "targetTemperatureStep": service.target_temperature_step,
                        "temperatureUnit": service.device_temperature_unit.value if service.device_temperature_unit else None,
                    })

            automation_devices.append({
                "virtualNodeId": virtual_node_id,
                "name": device.device_name or f"Device {virtual_node_id}",
                "deviceType": device.device_type,
                "protocol": device.protocol.value,
                "partitionId": partition_id,
                "services": services,
            })

        return web.json_response({"partitions": partitions, "zones": zones, "automationDevices": automation_devices})

    async def handle_command(self, request: web.Request) -> web.Response:
        try:
            payload: dict[str, Any] = await request.json()
        except Exception:
            return web.json_response({"error": "invalid_json"}, status=400)

        command_type = payload.get("type")
        if command_type == "arm":
            arming_type = payload.get("armingType")
            partition_id = str(payload.get("partitionId", "1"))
            user_code = payload.get("userCode", "")
            delay = int(payload.get("delay", 0))

            try:
                if arming_type == "DISARM":
                    await self.controller.command_disarm(partition_id, user_code=user_code, silent_disarming=False)
                elif arming_type == "ARM_AWAY":
                    await self.controller.command_arm(
                        partition_id,
                        arming_type=PartitionArmingType.ARM_AWAY,
                        user_code=user_code,
                        exit_sounds=True,
                        instant_arm=False,
                        entry_delay=delay > 0,
                    )
                elif arming_type == "ARM_STAY":
                    await self.controller.command_arm(
                        partition_id,
                        arming_type=PartitionArmingType.ARM_STAY,
                        user_code=user_code,
                        exit_sounds=True,
                        instant_arm=False,
                        entry_delay=delay > 0,
                    )
                elif arming_type == "ARM_NIGHT":
                    await self.controller.command_arm(
                        partition_id,
                        arming_type=PartitionArmingType.ARM_NIGHT,
                        user_code=user_code,
                        exit_sounds=True,
                        instant_arm=False,
                        entry_delay=delay > 0,
                    )
                else:
                    return web.json_response({"error": "unsupported_arming_type"}, status=400)
            except QolsysUserCodeError:
                return web.json_response({"error": "invalid_user_code"}, status=403)
            except (QolsysMqttError, QolsysSslError) as exc:
                return web.json_response({"error": "panel_error", "detail": str(exc)}, status=503)

            return web.json_response({"ok": True})

        if command_type == "automation":
            return await self.handle_automation_command(payload)

        return web.json_response({"error": "unsupported_command"}, status=400)

    async def handle_automation_command(self, payload: dict[str, Any]) -> web.Response:
        virtual_node_id = payload.get("virtualNodeId") or payload.get("virtual_node_id")
        endpoint = payload.get("endpoint", 0)
        action = payload.get("action")

        try:
            virtual_node_id_int = int(virtual_node_id)
            endpoint_int = int(endpoint)
        except (TypeError, ValueError):
            return web.json_response({"error": "invalid_device"}, status=400)

        automation_device = self.controller.state.automation_device(str(virtual_node_id_int))
        if not automation_device:
            return web.json_response({"error": "unknown_device"}, status=404)

        try:
            if action in {"light_on", "light_off", "light_level"}:
                service = automation_device.service_get(LightService, endpoint_int)
                if not isinstance(service, LightService):
                    return web.json_response({"error": "missing_light_service"}, status=404)

                if action == "light_on":
                    await service.turn_on()
                elif action == "light_off":
                    await service.turn_off()
                else:
                    level = int(payload.get("value", 0))
                    await service.set_level(level)

            elif action in {"lock", "unlock"}:
                service = automation_device.service_get(LockService, endpoint_int)
                if not isinstance(service, LockService):
                    return web.json_response({"error": "missing_lock_service"}, status=404)

                if action == "lock":
                    await service.lock()
                else:
                    await service.unlock()

            elif action in {"cover_open", "cover_close"}:
                service = automation_device.service_get(CoverService, endpoint_int)
                if not isinstance(service, CoverService):
                    return web.json_response({"error": "missing_cover_service"}, status=404)

                if action == "cover_open":
                    await service.open()
                else:
                    await service.close()

            elif action in {"siren_on", "siren_off"}:
                service = automation_device.service_get(SirenService, endpoint_int)
                if not isinstance(service, SirenService):
                    return web.json_response({"error": "missing_siren_service"}, status=404)

                if action == "siren_on":
                    await service.turn_on()
                else:
                    await service.turn_off()

            elif action in {"valve_open", "valve_close"}:
                service = automation_device.service_get(ValveService, endpoint_int)
                if not isinstance(service, ValveService):
                    return web.json_response({"error": "missing_valve_service"}, status=404)

                if action == "valve_open":
                    await service.open()
                else:
                    await service.close()

            elif action == "thermostat_mode":
                service = automation_device.service_get(ThermostatService, endpoint_int)
                if not isinstance(service, ThermostatService):
                    return web.json_response({"error": "missing_thermostat_service"}, status=404)

                mode_value = payload.get("mode")
                try:
                    hvac_mode = QolsysHvacMode(mode_value)
                except Exception:
                    return web.json_response({"error": "invalid_hvac_mode"}, status=400)

                await service.set_hvac_mode(hvac_mode)

            elif action == "thermostat_fan_mode":
                service = automation_device.service_get(ThermostatService, endpoint_int)
                if not isinstance(service, ThermostatService):
                    return web.json_response({"error": "missing_thermostat_service"}, status=404)

                fan_value = payload.get("fanMode") or payload.get("mode")
                try:
                    fan_mode = QolsysFanMode(fan_value)
                except Exception:
                    return web.json_response({"error": "invalid_fan_mode"}, status=400)

                await service.set_fan_mode(fan_mode)

            elif action in {"thermostat_heat", "thermostat_cool"}:
                service = automation_device.service_get(ThermostatService, endpoint_int)
                if not isinstance(service, ThermostatService):
                    return web.json_response({"error": "missing_thermostat_service"}, status=404)

                value = payload.get("value")
                try:
                    temperature = float(value)
                except (TypeError, ValueError):
                    return web.json_response({"error": "invalid_temperature"}, status=400)

                mode = QolsysHvacMode.HEAT if action == "thermostat_heat" else QolsysHvacMode.COOL
                await service.set_temperature(temperature, mode)

            else:
                return web.json_response({"error": "unsupported_action"}, status=400)

        except (QolsysMqttError, QolsysSslError) as exc:
            return web.json_response({"error": "panel_error", "detail": str(exc)}, status=503)

        return web.json_response({"ok": True})


def configure_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Qolsys PKI bridge for homebridge-qolsys")
    parser.add_argument("--config", default="config.json", help="Path to bridge config.json")
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    configure_logging(args.verbose)
    log = logging.getLogger("qolsys-bridge")

    config = load_config(args.config)
    bridge = QolsysBridge(config, log)

    stop_event = asyncio.Event()

    def _handle_signal() -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, _handle_signal)

    await bridge.start()
    await stop_event.wait()
    await bridge.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
