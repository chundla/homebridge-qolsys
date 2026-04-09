export enum QolsysZoneStatus{
  CLOSED,
  OPEN,
  Unknow
}

export enum QolsysZoneType{
  DoorWindow,
  GlassBreak,
  PanelGlassBreak,
  SmokeDetector,
  CODetector,
  Motion,
  PanelMotion,
  Water,
  AuxiliaryPendant,
  TakeoverModule,
  Bluetooth,
  Keypad,
  KeyFob,
  Tilt,
  Heat,
  Doorbell,
  Freeze,
  Unknow
}

export class QolsysZone{

  readonly ZoneId:number;
  PartitionId = 0;
  ZoneStatus = QolsysZoneStatus.Unknow;
  ZoneName = '';
  ZoneType = QolsysZoneType.Unknow;

  constructor(ZoneId: number){
    this.ZoneId = ZoneId;
  }

  SetZoneStatusFromString(Status:string):boolean{
    switch(Status){
      case 'Open':
        return this.SetZoneStatus(QolsysZoneStatus.OPEN);
      case 'Closed':
        return this.SetZoneStatus(QolsysZoneStatus.CLOSED);
      default:
        return this.SetZoneStatus(QolsysZoneStatus.Unknow);
    }
  }

  SetZoneStatus(Status:QolsysZoneStatus):boolean{
    if(Status !== this.ZoneStatus){
      this.ZoneStatus = Status;
      return true;
    }

    return false;
  }

  SetZoneType(Type:string){
    const raw = Type.trim();
    const normalized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_+/g, '_');

    switch (normalized) {
      case 'DOOR_WINDOW':
      case 'DOOR_WINDOW_M':
      case 'INTRUSION':
      case 'ENTRYEXIT':
      case 'ENTRY_EXIT_NORMAL_DELAY':
      case 'ENTRY_EXIT_LONG_DELAY':
      case 'PERIMETER':
      case 'INSTANT_PERIMETER_DW':
      case 'INSTANT_INTERIOR_DOOR':
      case 'AWAY_INSTANT_FOLLOWER_DELAY':
      case 'DOOR':
      case 'WINDOW':
      case 'CONTACT':
        this.ZoneType = QolsysZoneType.DoorWindow;
        return;

      case 'MOTION':
      case 'OCCUPANCY':
      case 'FOLLOWER':
      case 'MOTION_SENSOR':
      case 'PANEL_MOTION_SENSOR':
      case 'AWAY_INSTANT_MOTION':
      case 'STAY_INSTANT_MOTION':
      case 'STAY_DELAY_MOTION':
      case 'AWAY_DELAY_MOTION':
        this.ZoneType = QolsysZoneType.Motion;
        return;

      case 'PANEL_MOTION':
      case 'SAFETY_MOTION':
        this.ZoneType = QolsysZoneType.PanelMotion;
        return;

      case 'GLASS_BREAK':
        this.ZoneType = QolsysZoneType.GlassBreak;
        return;

      case 'PANEL_GLASS_BREAK':
        this.ZoneType = QolsysZoneType.PanelGlassBreak;
        return;

      case 'SMOKE_DETECTOR':
      case 'SMOKE_M':
        this.ZoneType = QolsysZoneType.SmokeDetector;
        return;

      case 'CO_DETECTOR':
      case 'CARBON_MONOXIDE':
      case 'CO':
        this.ZoneType = QolsysZoneType.CODetector;
        return;

      case 'WATER':
      case 'WATER_NON_REPORTING':
      case 'FLOOD':
        this.ZoneType = QolsysZoneType.Water;
        return;

      case 'FREEZE':
      case 'FREEZE_NON_REPORTING':
        this.ZoneType = QolsysZoneType.Freeze;
        return;

      case 'HEAT':
      case 'HIGH_TEMPERATURE':
        this.ZoneType = QolsysZoneType.Heat;
        return;

      case 'DOORBELL':
        this.ZoneType = QolsysZoneType.Doorbell;
        return;

      default:
        this.ZoneType = QolsysZoneType.Unknow;
    }
  }


}