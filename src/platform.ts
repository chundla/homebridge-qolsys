import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import path from 'path';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { QolsysController, QolsysControllerError } from './QolsysController.js';
import { TransportManager } from './transports/TransportManager.js';
import { QolsysAutomationCommand } from './transports/types.js';
import { QolsysZone, QolsysZoneStatus, QolsysZoneType} from './QolsysZone.js';
import { QolsysAlarmMode, QolsysPartition } from './QolsysPartition.js';
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
  private MqttCaPath = '';
  private MqttBridgeRootTopic = 'qolsys';
  private BridgeEndpoint = 'http://127.0.0.1:9123';
  public readonly Controller: QolsysController;
  private readonly Transport: TransportManager;

  private Partitions: Record<number, HKSecurityPanel> = {};
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
  private ShowGlassBreak = false;
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
      mqttCaPath: this.MqttCaPath,
      mqttBridgeRootTopic: this.MqttBridgeRootTopic,
      bridgeEndpoint: this.BridgeEndpoint,
      mqttBootstrapCaPath: path.resolve(this.api.user.storagePath(), 'qolsys-ca', 'mqtt_bridge_ca.cer'),
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

    if(this.config.ShowTilt !== undefined){
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

    if(this.config.BridgeEndpoint !== undefined && this.config.BridgeEndpoint !== ''){
      this.BridgeEndpoint = this.config.BridgeEndpoint;
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

    if(typeof this.config.MqttCaPath === 'string' && this.config.MqttCaPath !== ''){
      this.MqttCaPath = this.config.MqttCaPath;
    }

    if(this.config.MqttBridgeRootTopic !== undefined && this.config.MqttBridgeRootTopic !== ''){
      this.MqttBridgeRootTopic = this.config.MqttBridgeRootTopic;
    }

    this.PanelHost = Host;
    this.PanelPort = Port;
    this.PanelSecureToken = SecureToken;
    this.UserPinCode = UserPinCode;

    return true;
  }

  private CreatePartition(Partition: QolsysPartition): boolean {
    if (!this.ShowSecurityPanel) {
      this.log.info('Partition' + Partition.PartitionId + ': Skipped in config file');
      return false;
    }

    this.Partitions[Partition.PartitionId] = new HKSecurityPanel(
      this,
      Partition.PartitionId,
      Partition.PartitionName,
      'QolsysPartition' + Partition.PartitionId,
    );
    return true;
  }

  private DiscoverPartitions(){
    for(const PartitionId in this.Controller.GetPartitions()){
      const Partition = this.Controller.GetPartitions()[PartitionId];
      this.CreatePartition(Partition);
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
    const createdAccessoryUUIDs = new Set(this.CreatedAccessories.map((accessory) => accessory.UUID));
    const removedAccessories: string[] = [];
    for(let i = 0; i < this.accessories.length;i++){
      if(!createdAccessoryUUIDs.has(this.accessories[i].UUID)){
        removedAccessories.push(this.accessories[i].displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessories[i]]);
      }
    }

    if (removedAccessories.length > 0) {
      this.log.info('Removed stale accessories: ' + removedAccessories.join(', '));
    }
    this.log.info('Created accessories: ' + this.CreatedAccessories.length + ', cached accessories: ' + this.accessories.length);
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
        if (this.Transport.mode !== 'mqtt') {
          this.DeviceCacheCleanUp();
        } else {
          this.log.info('Skipping accessory cache cleanup in MQTT mode to avoid dropping late-discovered sensors.');
        }
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

      if (this.Zones[Zone.ZoneId] === undefined) {
        this.CreateSensor(Zone);
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

      if (this.Partitions[Partition.PartitionId] === undefined) {
        this.CreatePartition(Partition);
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


  private CreateSensor(Zone:QolsysZone):boolean{

    switch(Zone.ZoneType){
      case QolsysZoneType.Motion:
      case QolsysZoneType.PanelMotion:
      case QolsysZoneType.Unknow:{
        if(!this.ShowMotion){
          this.log.info('Zone' + Zone.ZoneId + ': Motion sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        if(this.MotionSensorMode === 'Motion'){
          this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
            'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, false);
        } else if(this.MotionSensorMode === 'Occupancy'){
          this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
            'QolsysZone' + Zone.ZoneType + Zone.ZoneId, false, true);
        } else {
          this.Zones[Zone.ZoneId] = new HKMotionOccupancySensor(this, Zone.ZoneId, Zone.ZoneName,
            'QolsysZone' + Zone.ZoneType + Zone.ZoneId, true, true);
        }

        return true;
      }

      case QolsysZoneType.DoorWindow:
        if(!this.ShowContact){
          this.log.info('Zone' + Zone.ZoneId + ': Contact sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.GlassBreak:
      case QolsysZoneType.PanelGlassBreak:
        if(!this.ShowGlassBreak){
          this.log.info('Zone' + Zone.ZoneId + ': Glass break sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.TakeoverModule:
      case QolsysZoneType.Bluetooth:
        if(!this.ShowContact){
          this.log.info('Zone' + Zone.ZoneId + ': Contact sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.Tilt:
        if(!this.ShowTilt){
          this.log.info('Zone' + Zone.ZoneId + ': Tilt sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.Freeze:
        if(!this.ShowFreeze){
          this.log.info('Zone' + Zone.ZoneId + ': Freeze sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKContactSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.Water:
        if(!this.ShowLeak){
          this.log.info('Zone' + Zone.ZoneId + ': Leak sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKLeakSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.SmokeDetector:
        if(!this.ShowSmoke){
          this.log.info('Zone' + Zone.ZoneId + ': Smoke sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKSmokeSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.Heat:
        if(!this.ShowHeat){
          this.log.info('Zone' + Zone.ZoneId + ': Heat sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKSmokeSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.CODetector:
        if(!this.ShowCO){
          this.log.info('Zone' + Zone.ZoneId + ': CO sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKCOSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      case QolsysZoneType.Doorbell:
        if(!this.ShowDoorbell){
          this.log.info('Zone' + Zone.ZoneId + ': Doorbell sensor disabled - ' + QolsysZoneType[Zone.ZoneType]);
          return false;
        }

        this.Zones[Zone.ZoneId] = new HKDoorbellSensor(this, Zone.ZoneId, Zone.ZoneName, 'QolsysZone' + Zone.ZoneType + Zone.ZoneId);
        return true;

      default:
        this.log.info('Zone' + Zone.ZoneId + ': No HomeKit mapping for - ' + QolsysZoneType[Zone.ZoneType]);
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