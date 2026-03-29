import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { QolsysController, QolsysControllerError } from './QolsysController.js';
import { TransportManager } from './transports/TransportManager.js';
import { QolsysAutomationCommand } from './transports/types.js';
import { QolsysZone, QolsysZoneStatus, QolsysZoneType} from './QolsysZone.js';
import { QolsysAlarmMode} from './QolsysPartition.js';
import { HKSecurityPanel } from './HKSecurityPanel.js';
import { HKContactSensor } from './HKContactSensor.js';
import { HKLeakSensor } from './HKLeakSensor.js';
import { HKSmokeSensor } from './HKSmokeSensor.js';
import { HKCOSensor } from './HKCOSensor.js';
import { HKDoorbellSensor } from './HKDoorbellSensor.js';
import { HKSensor } from './HKSensor.js';
import { HKMotionOccupancySensor } from './HKMotionOccupancySensor.js';
import { HKAutomationLight } from './HKAutomationLight.js';
import { HKAutomationLock } from './HKAutomationLock.js';
import { HKAutomationCover } from './HKAutomationCover.js';
import { HKAutomationSiren } from './HKAutomationSiren.js';
import { HKAutomationValve } from './HKAutomationValve.js';
import { HKAutomationThermostat } from './HKAutomationThermostat.js';
import { BridgeAutomationDeviceSnapshot, BridgeAutomationServiceSnapshot } from './transports/bridgeTypes.js';

export enum HKSensorType {
  MotionSensor = 'MotionSensor',
  ContactSensor = 'ContactSensor',
  LeakSensor = 'LeakSensor',
  SmokeSensor = 'SmokeSensor',
  COSensor = 'COSensor',
  OccupancySensor = 'OccupancySensor',
  MotionOccupancySensor = 'MotionOccupancySensor',
  DoorbellSensor = 'DoorbellSensor'
}

type HKAutomationAccessory = {
  Accessory: PlatformAccessory;
  UpdateFromService: (service: BridgeAutomationServiceSnapshot) => void;
};

export class HBQolsysPanel implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public accessories: PlatformAccessory[] = [];
  public CreatedAccessories: PlatformAccessory[] = [];

  private PanelHost = '';
  private PanelPort = 14999;
  private PanelSecureToken = '';
  private UserPinCode = '';
  private TransportMode = 'c4';
  private MqttUrl = 'mqtt://127.0.0.1:1883';
  private MqttUsername = '';
  private MqttPassword = '';
  private MqttClientId = 'homebridge-qolsys';
  private MqttStateTopic = 'qolsys/state';
  private MqttCommandTopic = 'qolsys/command';
  private BridgeAutoStart = false;
  private BridgeEndpoint = 'http://127.0.0.1:9123';
  private BridgePythonPath = 'python3';
  private BridgeVenvPath = '';
  private BridgeConfigPath = '';
  private BridgeForceVenvRecreate = false;
  private BridgePanelIp = '';
  private BridgePanelMac = '';
  private BridgePluginIp = '';
  private BridgeProcess?: ChildProcessWithoutNullStreams;
  private BridgeDepsReady = false;
  private BridgePairingTimer?: NodeJS.Timeout;
  private BridgePairingLastLog?: number;
  private BridgeHealthTimer?: NodeJS.Timeout;
  public readonly Controller: QolsysController;
  private readonly Transport: TransportManager;

  private Zones:Record<number, HKSensor> = {};
  private AutomationAccessories: Record<string, HKAutomationAccessory | undefined> = {};
  private InitialRun = true;
  private ReceivingPanelNotification = false;

  private ShowSecurityPanel = true;
  private ShowMotion = true;
  private ShowContact = true;
  private ShowCO = true;
  private ShowSmoke = true;
  private ShowHeat = true;
  private ShowLeak = true;
  private ShowTilt = true;
  private ShowDoorbell = true;
  private ShowFreeze = true;
  private ShowBluetooth = false;
  private ShowGlassBreak = false;
  private ShowTakeover = false;
  private ShowAutomationLocks = true;
  private ShowAutomationLights = true;
  private ShowAutomationThermostats = true;
  private ShowAutomationCovers = true;
  private ShowAutomationSirens = true;
  private ShowAutomationValves = true;
  private LogPartition = true;
  private LogZone = false;
  private LogDebug = false;
  ForceArm = true;
  AwayExitDelay = 120;
  HomeExitDelay = 120;
  SensorDelay = true;

  // Motion Occupancy sensors options
  MotionDelay = 5;
  OccupancyDelay = 15;
  MotionSensorMode = 'Motion';

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {

    if(!this.CheckConfig()){
      this.Transport = new TransportManager(this.log, 'c4', {
        host: this.PanelHost,
        port: this.PanelPort,
      });
      this.Controller = this.Transport.controller;
      return;
    }

    this.Transport = new TransportManager(this.log, this.TransportMode as 'c4' | 'mqtt', {
      host: this.PanelHost,
      port: this.PanelPort,
      secureToken: this.PanelSecureToken,
      userPinCode: this.UserPinCode,
      mqttUrl: this.MqttUrl,
      mqttUsername: this.MqttUsername,
      mqttPassword: this.MqttPassword,
      mqttClientId: this.MqttClientId,
      mqttStateTopic: this.MqttStateTopic,
      mqttCommandTopic: this.MqttCommandTopic,
      bridgeEndpoint: this.BridgeEndpoint,
    });
    this.Controller = this.Transport.controller;

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.push(accessory);
  }

  // First config check
  // check if panel host, port and passcode are set
  CheckConfig():boolean{
    const Host = this.config.Host;
    const Port = this.config.Port;
    const SecureToken = this.config.SecureToken;
    const UserPinCode = this.config.UserPinCode;
    const TransportMode = this.config.TransportMode;
    const MqttUrl = this.config.MqttUrl;

    if(Host === undefined || Host === ''){
      this.log.error('Aborting plugin operation - Invalid Host: ' + Host);
      return false;
    }

    if(Port === undefined || isNaN(Port)){
      this.log.error('Aborting plugin operation - Invalid Port: ' + Port);
      return false;
    }

    if(SecureToken === undefined || SecureToken === ''){
      this.log.error('Aborting plugin operation - Invalid SecureToken');
      return false;
    }

    if(UserPinCode === undefined || UserPinCode === ''){
      this.log.error('Aborting plugin operation - Invalid User Pin Code');
      return false;
    }

    if(this.config.ShowSecurityPanel !== undefined){
      this.ShowSecurityPanel = this.config.ShowSecurityPanel;
    }

    if(this.config.ShowMotion !== undefined){
      this.ShowMotion = this.config.ShowMotion;
    }

    if(this.config.ShowContact !== undefined){
      this.ShowContact = this.config.ShowContact;
    }

    if(this.config.ShowCO !== undefined){
      this.ShowCO = this.config.ShowCO;
    }

    if(this.config.ShowSmoke !== undefined){
      this.ShowSmoke = this.config.ShowSmoke;
    }

    if(this.config.ShowHeat !== undefined){
      this.ShowHeat = this.config.ShowHeat;
    }

    if(this.config.ShowLeak !== undefined){
      this.ShowLeak = this.config.ShowLeak;
    }

    if(this.config.Tilt !== undefined){
      this.ShowTilt = this.config.ShowTilt;
    }

    if(this.config.ShowGlassBreak !== undefined){
      this.ShowGlassBreak = this.config.ShowGlassBreak;
    }

    if(this.config.ShowDoorbell !== undefined){
      this.ShowDoorbell = this.config.ShowDoorbell;
    }

    if(this.config.ShowFreeze !== undefined){
      this.ShowFreeze = this.config.ShowFreeze;
    }

    if(this.config.ShowAutomationLocks !== undefined){
      this.ShowAutomationLocks = this.config.ShowAutomationLocks;
    }

    if(this.config.ShowAutomationLights !== undefined){
      this.ShowAutomationLights = this.config.ShowAutomationLights;
    }

    if(this.config.ShowAutomationThermostats !== undefined){
      this.ShowAutomationThermostats = this.config.ShowAutomationThermostats;
    }

    if(this.config.ShowAutomationCovers !== undefined){
      this.ShowAutomationCovers = this.config.ShowAutomationCovers;
    }

    if(this.config.ShowAutomationSirens !== undefined){
      this.ShowAutomationSirens = this.config.ShowAutomationSirens;
    }

    if(this.config.ShowAutomationValves !== undefined){
      this.ShowAutomationValves = this.config.ShowAutomationValves;
    }

    if(this.config.LogPartition !== undefined){
      this.LogPartition = this.config.LogPartition;
    }

    if(this.config.BridgeAutoStart !== undefined){
      this.BridgeAutoStart = this.config.BridgeAutoStart;
    }

    if(this.config.BridgeEndpoint !== undefined && this.config.BridgeEndpoint !== ''){
      this.BridgeEndpoint = this.config.BridgeEndpoint;
    }

    if(this.config.BridgePythonPath !== undefined && this.config.BridgePythonPath !== ''){
      this.BridgePythonPath = this.config.BridgePythonPath;
    }

    if(this.config.BridgeVenvPath !== undefined){
      this.BridgeVenvPath = this.config.BridgeVenvPath;
    }

    if(this.config.BridgeConfigPath !== undefined){
      this.BridgeConfigPath = this.config.BridgeConfigPath;
    }

    if(this.config.BridgeForceVenvRecreate !== undefined){
      this.BridgeForceVenvRecreate = this.config.BridgeForceVenvRecreate;
    }

    if(this.config.BridgePanelIp !== undefined){
      this.BridgePanelIp = this.config.BridgePanelIp;
    }

    if(this.config.BridgePanelMac !== undefined){
      this.BridgePanelMac = this.config.BridgePanelMac;
    }

    if(this.config.BridgePluginIp !== undefined){
      this.BridgePluginIp = this.config.BridgePluginIp;
    }

    if(this.config.LogZone !== undefined){
      this.LogZone = this.config.LogZone;
    }

    if(this.config.LogDebug !== undefined){
      this.LogDebug = this.config.LogDebug;
    }

    if(this.config.ForceArm !== undefined){
      this.ForceArm = this.config.ForceArm;
    }

    if(this.config.AwayExitDelay !== undefined){
      this.AwayExitDelay = this.config.AwayExitDelay;
    }

    if(this.config.HomeExitDelay !== undefined){
      this.HomeExitDelay = this.config.HomeExitDelay;
    }

    if(this.config.OccupancyDelay !== undefined){
      this.OccupancyDelay = this.config.OccupancyDelay;
    }

    if(this.config.MotionDelay !== undefined){
      this.MotionDelay = this.config.MotionDelay;
    }

    if(this.config.MotionSensorMode !== undefined){
      this.MotionSensorMode = this.config.MotionSensorMode;
    }

    if(TransportMode !== undefined){
      if(TransportMode !== 'c4' && TransportMode !== 'mqtt'){
        this.log.warn('Invalid TransportMode value: ' + TransportMode + '. Falling back to c4.');
      } else{
        this.TransportMode = TransportMode;
      }
    }

    if(MqttUrl !== undefined && MqttUrl !== ''){
      this.MqttUrl = MqttUrl;
    }

    if(this.config.MqttUsername !== undefined){
      this.MqttUsername = this.config.MqttUsername;
    }

    if(this.config.MqttPassword !== undefined){
      this.MqttPassword = this.config.MqttPassword;
    }

    if(this.config.MqttClientId !== undefined && this.config.MqttClientId !== ''){
      this.MqttClientId = this.config.MqttClientId;
    }

    if(this.config.MqttStateTopic !== undefined && this.config.MqttStateTopic !== ''){
      this.MqttStateTopic = this.config.MqttStateTopic;
    }

    if(this.config.MqttCommandTopic !== undefined && this.config.MqttCommandTopic !== ''){
      this.MqttCommandTopic = this.config.MqttCommandTopic;
    }

    this.PanelHost = Host;
    this.PanelPort = Port;
    this.PanelSecureToken = SecureToken;
    this.UserPinCode = UserPinCode;

    return true;
  }

  private DiscoverPartitions(){
    for(const PartitionId in this.Controller.GetPartitions()){

      const Partition = this.Controller.GetPartitions()[PartitionId];

      if(!this.ShowSecurityPanel){
        this.log.info('Partition' + Partition.PartitionId + ': Skipped in config file');
        continue;
      }

      new HKSecurityPanel(this, Partition.PartitionId, Partition.PartitionName, 'QolsysPartition' + Partition.PartitionId);
    }
  }

  private DiscoverZones(){
    for(const ZoneId in this.Controller.GetZones()){
      const Zone = this.Controller.GetZones()[ZoneId];
      this.CreateSensor(Zone);
    }
  }

  private DiscoverAutomationDevices(){
    const devices = Object.values(this.Controller.GetAutomationDevices());
    this.UpdateAutomationDevices(devices);
  }

  private UpdateAutomationDevices(devices: BridgeAutomationDeviceSnapshot[]){
    const seen = new Set<string>();

    for (const device of devices){
      if (!Array.isArray(device.services)){
        continue;
      }

      for (const service of device.services){
        const key = this.AutomationKey(device, service);
        let accessory = this.AutomationAccessories[key];
        if (!accessory){
          accessory = this.CreateAutomationAccessory(device, service);
        }
        if (accessory){
          accessory.UpdateFromService(service);
          seen.add(key);
        }
      }
    }

    for (const key of Object.keys(this.AutomationAccessories)){
      if (!seen.has(key)){
        const accessory = this.AutomationAccessories[key];
        if (accessory){
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory.Accessory]);
        }
        delete this.AutomationAccessories[key];
      }
    }
  }

  private AutomationKey(device: BridgeAutomationDeviceSnapshot, service: BridgeAutomationServiceSnapshot): string {
    return `${device.virtualNodeId}-${service.type}-${service.endpoint ?? 0}`;
  }

  private CreateAutomationAccessory(
    device: BridgeAutomationDeviceSnapshot,
    service: BridgeAutomationServiceSnapshot,
  ): HKAutomationAccessory | undefined {
    const key = this.AutomationKey(device, service);

    let accessory: HKAutomationAccessory | undefined;

    switch(service.type){
      case 'light':
        if (!this.ShowAutomationLights){
          return undefined;
        }
        accessory = new HKAutomationLight(this, device, service);
        break;
      case 'lock':
        if (!this.ShowAutomationLocks){
          return undefined;
        }
        accessory = new HKAutomationLock(this, device, service);
        break;
      case 'cover':
        if (!this.ShowAutomationCovers){
          return undefined;
        }
        accessory = new HKAutomationCover(this, device, service);
        break;
      case 'siren':
        if (!this.ShowAutomationSirens){
          return undefined;
        }
        accessory = new HKAutomationSiren(this, device, service);
        break;
      case 'valve':
        if (!this.ShowAutomationValves){
          return undefined;
        }
        accessory = new HKAutomationValve(this, device, service);
        break;
      case 'thermostat':
        if (!this.ShowAutomationThermostats){
          return undefined;
        }
        accessory = new HKAutomationThermostat(this, device, service);
        break;
      default:
        this.log.debug(`Automation device ${device.name} has unsupported service type ${service.type}`);
        return undefined;
    }

    if (accessory){
      this.AutomationAccessories[key] = accessory;
    }

    return accessory;
  }

  private DeviceCacheCleanUp(){
    // Do some cleanup of point that have been restored and are not in config file anymore
    for(let i = 0; i < this.accessories.length;i++){
      if(this.CreatedAccessories.indexOf(this.accessories[i]) === -1){
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessories[i]]);
      }
    }
  }

  discoverDevices() {

    this.Controller.on('PanelReadyForOperation', () => {

      this.DumpPanelInfo();

      if(this.InitialRun){
        this.log.info('-----------------------------------------');
        this.log.info('Configuring Homebridge plugin accessories');
        this.log.info('-----------------------------------------');
        this.DiscoverPartitions();
        this.DiscoverZones();
        this.DiscoverAutomationDevices();
        this.DeviceCacheCleanUp();
        this.InitialRun = false;
      }

      // Start panel event notifications.
      if (this.Transport.mode !== 'mqtt') {
        this.log.info('-----------------------------------------');
        this.log.info('Starting Controller Operation');
        this.log.info('-----------------------------------------');
        this.Controller.StartOperation();
      }
    });

    this.Controller.on('PrintDebugInfo', (DebugString) => {
      if(this.LogDebug){
        this.log.info(DebugString);
      } else{
        this.log.debug(DebugString);
      }
    });

    this.Controller.on('ZoneStatusChange', (Zone) => {
      const msg = 'Zone' + Zone.ZoneId + '(' + Zone.ZoneName + '): ' + QolsysZoneStatus[Zone.ZoneStatus];
      if(this.LogZone){
        this.log.info(msg);
      } else{
        this.log.debug(msg);
      }

      const Sensor = this.Zones[Zone.ZoneId];
      if(Sensor !== undefined){
        Sensor.HandleEventDetected(Zone.ZoneStatus);
      }
    });

    this.Controller.on('AutomationDevicesUpdated', (devices) => {
      this.UpdateAutomationDevices(devices);
    });

    this.Controller.on('PartitionAlarmModeChange', (Partition)=>{
      const msg = 'Partition'+ Partition.PartitionId + '(' + Partition.PartitionName +'): ' + QolsysAlarmMode[Partition.PartitionStatus];
      if(this.LogPartition){
        this.log.info(msg);
      } else{
        this.log.debug(msg);
      }
    });


    this.Controller.on('ControllerError', (Error, ErrorString) => {
      this.log.error(Error + ' (' + ErrorString + ')');

      // Reconnect if connection to panel has been lost
      if(Error === QolsysControllerError.ConnectionError){

        if(this.ReceivingPanelNotification === true){
          this.ReceivingPanelNotification = false;
          this.log.info('-----------------------------------------');
          this.log.info('Stopping Control Panel Operation');
          this.log.info('-----------------------------------------');
        }

        setTimeout(() => {
          this.log.info('Trying to reconnect ....');
          this.Transport.connect();
        }, 60000); // Try to reconnect every 60 sec
      }
    });

    // Start panel initialisation
    this.Transport.connect();
  }

  public SendArmCommand(armingType: QolsysAlarmMode, partitionId: number, delay: number, bypass: boolean): void {
    void this.Transport.sendArmCommand({
      armingType,
      partitionId,
      delay,
      bypass,
      userCode: this.UserPinCode,
    });
  }

  public SendAutomationCommand(command: QolsysAutomationCommand): void {
    if (this.LogDebug) {
      this.log.info(`[automation] send ${command.action} node=${command.virtualNodeId} endpoint=${command.endpoint}`);
    }
    void this.Transport.sendAutomationCommand(command);
  }

  private ensureBridgeRunning(): void {
    if (this.TransportMode !== 'pki' || !this.BridgeAutoStart) {
      return;
    }

    if (this.BridgeProcess) {
      return;
    }

    const storagePath = this.api.user.storagePath();
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const bridgeDir = path.resolve(rootDir, 'bridge');
    const venvPath = this.BridgeVenvPath && this.BridgeVenvPath.length > 0
      ? this.BridgeVenvPath
      : path.resolve(storagePath, 'qolsys-bridge', '.venv');
    const configPath = this.BridgeConfigPath && this.BridgeConfigPath.length > 0
      ? this.BridgeConfigPath
      : path.resolve(storagePath, 'qolsys-bridge', 'config.json');
    const pythonExecutable = this.BridgePythonPath || 'python3';
    const venvPython = path.resolve(venvPath, 'bin', 'python');
    const requirementsPath = path.resolve(bridgeDir, 'requirements.txt');
    const appPath = path.resolve(bridgeDir, 'app.py');

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
    } catch (error) {
      this.log.error('Failed to create bridge config directory: ' + (error as Error).message);
      return;
    }

    if (!fs.existsSync(configPath)) {
      this.log.warn('BridgeAutoStart is enabled but config.json is missing: ' + configPath);
      if (!this.writeBridgeConfig(configPath)) {
        this.log.warn('Create the bridge config file first; auto-start skipped.');
        return;
      }
      this.log.info('Created bridge config template at ' + configPath);
    }

    if (this.BridgeForceVenvRecreate && fs.existsSync(venvPath)) {
      this.log.warn('BridgeForceVenvRecreate enabled. Removing venv at ' + venvPath);
      fs.rmSync(venvPath, { recursive: true, force: true });
    }

    if (!fs.existsSync(venvPython)) {
      this.log.info('Creating bridge venv at ' + venvPath);
      const create = spawn(pythonExecutable, ['-m', 'venv', venvPath]);
      create.on('exit', (code) => {
        if (code !== 0) {
          this.log.error('Failed to create bridge venv (exit ' + code + ')');
          return;
        }
        this.installBridgeDeps(venvPython, requirementsPath, appPath, configPath, venvPath);
      });
      return;
    }

    if (this.BridgeDepsReady) {
      this.startBridgeProcess(venvPython, appPath, configPath);
      return;
    }

    if (this.isBridgeDepsUpToDate(venvPath, requirementsPath)) {
      this.BridgeDepsReady = true;
      this.startBridgeProcess(venvPython, appPath, configPath);
      return;
    }

    this.installBridgeDeps(venvPython, requirementsPath, appPath, configPath, venvPath);
  }

  private installBridgeDeps(venvPython: string, requirementsPath: string, appPath: string, configPath: string, venvPath: string): void {
    this.log.info('Ensuring bridge dependencies are installed.');
    const pip = spawn(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath]);
    pip.stdout.on('data', (data) => this.log.debug('[bridge][pip] ' + data.toString().trim()));
    pip.stderr.on('data', (data) => this.log.warn('[bridge][pip] ' + data.toString().trim()));
    pip.on('exit', (code) => {
      if (code !== 0) {
        this.log.error('Bridge dependency install failed (exit ' + code + ')');
        return;
      }
      this.BridgeDepsReady = true;
      this.writeBridgeDepsStamp(venvPath, requirementsPath);
      this.startBridgeProcess(venvPython, appPath, configPath);
    });
  }

  private bridgeStampPath(venvPath: string): string {
    return path.resolve(venvPath, '.deps-stamp');
  }

  private writeBridgeConfig(configPath: string): boolean {
    try {
      const payload = {
        panel_ip: this.BridgePanelIp || this.PanelHost || '',
        panel_mac: this.BridgePanelMac || '',
        random_mac: '',
        config_dir: path.dirname(configPath),
        plugin_ip: this.BridgePluginIp || '',
        auto_discover_pki: false,
        start_pairing: true,
        check_user_code_on_arm: false,
        check_user_code_on_disarm: false,
        log_mqtt_messages: false,
        http_host: '127.0.0.1',
        http_port: 9123,
      };
      fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf-8');
      return true;
    } catch (error) {
      this.log.error('Failed to write bridge config: ' + (error as Error).message);
      return false;
    }
  }

  private isBridgeDepsUpToDate(venvPath: string, requirementsPath: string): boolean {
    try {
      const stampPath = this.bridgeStampPath(venvPath);
      if (!fs.existsSync(stampPath)) {
        return false;
      }
      const stamp = fs.readFileSync(stampPath, 'utf-8').trim();
      const requirements = fs.readFileSync(requirementsPath, 'utf-8').trim();
      return stamp === requirements;
    } catch (error) {
      this.log.warn('Bridge dependency stamp check failed: ' + (error as Error).message);
      return false;
    }
  }

  private writeBridgeDepsStamp(venvPath: string, requirementsPath: string): void {
    try {
      const stampPath = this.bridgeStampPath(venvPath);
      const requirements = fs.readFileSync(requirementsPath, 'utf-8').trim();
      fs.writeFileSync(stampPath, requirements, 'utf-8');
    } catch (error) {
      this.log.warn('Failed to write bridge dependency stamp: ' + (error as Error).message);
    }
  }

  private startBridgeProcess(venvPython: string, appPath: string, configPath: string): void {
    this.log.info('Starting PKI bridge process...');
    this.BridgeProcess = spawn(venvPython, [appPath, '--config', configPath], { env: process.env });

    this.BridgeProcess.stdout.on('data', (data) => this.log.info('[bridge] ' + data.toString().trim()));
    this.BridgeProcess.stderr.on('data', (data) => this.log.warn('[bridge] ' + data.toString().trim()));

    this.BridgeProcess.on('exit', (code) => {
      this.log.warn('PKI bridge exited (code ' + code + ').');
      this.BridgeProcess = undefined;
      if (this.BridgePairingTimer) {
        clearInterval(this.BridgePairingTimer);
        this.BridgePairingTimer = undefined;
      }
      if (this.BridgeHealthTimer) {
        clearInterval(this.BridgeHealthTimer);
        this.BridgeHealthTimer = undefined;
      }
    });

    this.api.on('shutdown', () => {
      if (this.BridgeProcess) {
        this.log.info('Stopping PKI bridge process...');
        this.BridgeProcess.kill('SIGTERM');
        this.BridgeProcess = undefined;
      }
      if (this.BridgePairingTimer) {
        clearInterval(this.BridgePairingTimer);
        this.BridgePairingTimer = undefined;
      }
      if (this.BridgeHealthTimer) {
        clearInterval(this.BridgeHealthTimer);
        this.BridgeHealthTimer = undefined;
      }
    });

    this.startBridgePairingMonitor(configPath);
  }

  private startBridgePairingMonitor(configPath: string): void {
    if (this.BridgePairingTimer) {
      return;
    }

    this.BridgePairingTimer = setInterval(() => {
      this.checkBridgePairing(configPath);
    }, 15000);

    this.checkBridgePairing(configPath);
  }

  private waitForBridgeHealthThenConnect(): void {
    if (this.BridgeHealthTimer) {
      return;
    }

    this.BridgeHealthTimer = setInterval(() => {
      this.checkBridgeHealth(() => {
        if (this.BridgeHealthTimer) {
          clearInterval(this.BridgeHealthTimer);
          this.BridgeHealthTimer = undefined;
        }
        this.Transport.connect();
      });
    }, 5000);

    this.checkBridgeHealth(() => {
      if (this.BridgeHealthTimer) {
        clearInterval(this.BridgeHealthTimer);
        this.BridgeHealthTimer = undefined;
      }
      this.Transport.connect();
    });
  }

  private checkBridgeHealth(onHealthy: () => void): void {
    const healthUrl = new URL('/health', this.BridgeEndpoint);
    const client = healthUrl.protocol === 'https:' ? https : http;

    const req = client.get(healthUrl.toString(), (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return;
        }
        try {
          const payload = JSON.parse(raw);
          if (payload && payload.connected) {
            onHealthy();
          }
        } catch (error) {
          // ignore
        }
      });
    });

    req.on('error', () => {
      // ignore
    });
  }

  private checkBridgePairing(configPath: string): void {
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      this.log.warn('Bridge pairing check failed to read config: ' + (error as Error).message);
      return;
    }

    if (!config.start_pairing) {
      return;
    }

    const now = Date.now();
    if (!this.BridgePairingLastLog || now - this.BridgePairingLastLog > 60000) {
      this.log.info('PKI pairing required — press Pair on the IQ Remote config page.');
      this.BridgePairingLastLog = now;
    }

    const healthUrl = new URL('/health', this.BridgeEndpoint);
    const client = healthUrl.protocol === 'https:' ? https : http;

    const req = client.get(healthUrl.toString(), (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return;
        }
        try {
          const payload = JSON.parse(raw);
          if (payload && payload.paired) {
            if (payload.random_mac) {
              config.random_mac = payload.random_mac;
            }
            config.start_pairing = false;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            this.log.info('PKI pairing complete. Bridge config updated.');
          }
        } catch (error) {
          this.log.warn('Bridge pairing check failed to parse health response.');
        }
      });
    });

    req.on('error', () => {
      // ignore
    });
  }

  private CreateSensor(Zone:QolsysZone):boolean{

    switch(Zone.ZoneType){

      case QolsysZoneType.Motion:{

        if(this.ShowMotion){

          if(this.MotionSensorMode === 'Motion'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, false);
          }

          if(this.MotionSensorMode === 'Occupancy'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, false, true);
          }

          if(this.MotionSensorMode === 'MotionOccupancy'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, true);
          }

          return true;

        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.PanelMotion:{
        if(this.ShowMotion){

          if(this.MotionSensorMode === 'Motion'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, false);
          }

          if(this.MotionSensorMode === 'Occupancy'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, false, true);
          }

          if(this.MotionSensorMode === 'MotionOccupancy'){
            this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
              'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, true);
          }

          return true;

        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.DoorWindow:{
        if(this.ShowContact){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Water :{
        if(this.ShowLeak){
          this.Zones[Zone.ZoneId] = new HKLeakSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.SmokeDetector :{
        if(this.ShowSmoke){
          this.Zones[Zone.ZoneId] = new HKSmokeSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Heat :{
        if(this.ShowHeat){
          this.Zones[Zone.ZoneId] = new HKSmokeSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.CODetector :{
        if(this.ShowCO){
          this.Zones[Zone.ZoneId] = new HKCOSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Bluetooth :{
        if(this.ShowBluetooth){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': No HomeKit plugin available - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.GlassBreak :{
        if(this.ShowGlassBreak){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.PanelGlassBreak :{
        if(this.ShowGlassBreak){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.TakeoverModule :{
        if(this.ShowTakeover){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': No HomeKit plugin available - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Tilt :{
        if(this.ShowTilt){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Doorbell:{
        if(this.ShowDoorbell){
          this.Zones[Zone.ZoneId] = new HKDoorbellSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      case QolsysZoneType.Freeze :{
        if(this.ShowFreeze){
          this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
          return true;
        } else{
          this.log.info('Zone' + Zone.ZoneId + ': Skipped in config file - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }
      }

      default:
        this.log.info('Zone' + Zone.ZoneId + ': No HomeKit plugin available - ' + QolsysZoneType[Zone.ZoneType]);
        return false;
    }
  }

  private DumpPanelInfo(){
    this.log.info('-----------------------------------------');
    this.log.info('Qolsys Panel Information');
    this.log.info('-----------------------------------------');

    this.log.info('Motion sensor mode: ' + this.MotionSensorMode);

    for (const PartitionId in this.Controller.GetPartitions()){
      const Partition = this.Controller.GetPartitions()[PartitionId];
      this.log.info('Partition' + Partition.PartitionId + ': ' + Partition.PartitionName);

      for(const ZoneId in this.Controller.GetZones()){
        const Zone = this.Controller.GetZones()[ZoneId];
        if(Zone.PartitionId === Partition.PartitionId){
          this.log.info('  Zone' + Zone.ZoneId + ': ' + Zone.ZoneName);
        }
      }
    }
  }
}