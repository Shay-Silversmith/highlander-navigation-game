import { describe, expect, it } from 'vitest';
import { evaluateArrival, GameError, startGame, trackProgress, type GameRules } from '../server/src/core/game.js';
import { haversineM } from '../server/src/core/geo.js';
import { RoadGraph } from '../server/src/core/graph.js';
const rules: GameRules = {goalMinRouteM:300,goalMaxRouteM:800,reachThresholdM:20,maxArrivalAccuracyM:50,maxSnapM:250};
const bbox={south:-0.01,west:-0.01,north:0.01,east:0.01};
const line=new RoadGraph({bbox,lat:[0,0,0],lon:[0,0.004,0.006],edges:[0,1,1,2]});
const fix={lat:0,lon:0,accuracyM:5};
function errorCode(fn:()=>unknown, code:string) {try {fn(); throw new Error('Expected GameError');} catch(error) {expect(error).toBeInstanceOf(GameError); expect((error as GameError).code).toBe(code);}}
describe('game lifecycle',()=>{
  it('starts with a reachable bounded goal and tracks it without changing it',()=>{
    const started=startGame(line,fix,rules,()=>0);
    expect(started.progress.arrival).toBe('EN_ROUTE');
    expect(started.progress.route.distanceM).toBeGreaterThanOrEqual(rules.goalMinRouteM);
    expect(started.progress.route.distanceM).toBeLessThanOrEqual(rules.goalMaxRouteM);
    const copy={...started.goal};
    const reached=trackProgress(line,{...started.goal,accuracyM:5},started.goal,rules);
    expect(reached.arrival).toBe('REACHED'); expect(reached.route.distanceM).toBe(0);
    expect(started.goal).toEqual(copy);
  });
  it('uses raw fix for arrival, not a snap that might land on the goal',()=>{
    const goal={lat:0,lon:0};
    const progress=trackProgress(line,{lat:0.0003,lon:0,accuracyM:5},goal,rules);
    expect(progress.route.distanceM).toBe(0); expect(progress.arrival).toBe('EN_ROUTE');
    expect(progress.distanceToGoalM).toBeGreaterThan(20);
  });
  it('gates arrival by accuracy and includes exact thresholds',()=>{
    const goal={lat:0,lon:0};
    expect(evaluateArrival({...goal,accuracyM:50},goal,rules)).toBe('REACHED');
    expect(evaluateArrival({...goal,accuracyM:50.0001},goal,rules)).toBe('UNCERTAIN');
    const near={lat:0,lon:0.0001,accuracyM:5}; const distance=haversineM(near,goal);
    expect(evaluateArrival(near,goal,{...rules,reachThresholdM:distance})).toBe('REACHED');
    expect(evaluateArrival(near,goal,{...rules,reachThresholdM:distance-0.0001})).toBe('EN_ROUTE');
  });
  it('reports off-network and no-candidate failures clearly',()=>{
    errorCode(()=>startGame(line,{...fix,lat:1},rules,()=>0),'OFF_NETWORK');
    errorCode(()=>startGame(line,fix,{...rules,goalMinRouteM:750},()=>0),'NO_GOAL_AVAILABLE');
  });
  it('reports disconnected routes instead of claiming arrival',()=>{
    const islands=new RoadGraph({bbox,lat:[0,0,0.001,0.001],lon:[0,0.001,0,0.001],edges:[0,1,2,3]});
    errorCode(()=>trackProgress(islands,fix,{lat:0.001,lon:0},rules),'NO_ROUTE');
  });
  it('does not start already reached on a U-shaped road',()=>{
    const u=new RoadGraph({bbox,lat:[0,0,0.0001,0.0001],lon:[0,0.002,0.002,0],edges:[0,1,1,2,2,3]});
    // Only the last node is >=300 m by road; it is only 11 m from the initial fix.
    // With no suitable goal, a clear NO_GOAL_AVAILABLE is also correct.
    try { expect(startGame(u,fix,rules,()=>0).progress.arrival).toBe('EN_ROUTE'); }
    catch(error) { if (error instanceof GameError) expect(error.code).toBe('NO_GOAL_AVAILABLE'); else throw error; }
  });
});
