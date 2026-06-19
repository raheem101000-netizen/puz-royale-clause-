/* colyseus-adapter.js — socket.io API shim over Colyseus SDK
 * play-mp2.html path → joins puz_room by URL ?room=ID
 * All other paths (rooms.html) → joins puz_lobby singleton
 */
(function () {
  'use strict';

  var isGame = location.pathname.indexOf('play-mp2') !== -1;
  var roomIdFromURL = new URLSearchParams(location.search).get('room');
  var serverURL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;

  var _sdkReady = false;
  var _sdkQueue = [];

  function whenReady(fn) {
    if (_sdkReady) { fn(); } else { _sdkQueue.push(fn); }
  }

  var script = document.createElement('script');
  script.src = '/colyseus-sdk.js';
  script.onload = function () {
    _sdkReady = true;
    var q = _sdkQueue.splice(0);
    for (var i = 0; i < q.length; i++) { q[i](); }
  };
  script.onerror = function () { console.error('[colyseus-adapter] Failed to load SDK'); };
  document.head.appendChild(script);

  window.io = function () {
    var handlers = {};
    var mgr = {};
    var pending = [];
    var _room = null;
    var _roomId = null;
    var _connected = false;
    var _attempts = 0;

    var socket = {
      get connected() { return _connected; },
      id: null,
      io: {
        on: function (ev, cb) {
          if (!mgr[ev]) mgr[ev] = [];
          mgr[ev].push(cb);
        }
      },
      on: function (ev, cb) {
        if (!handlers[ev]) handlers[ev] = [];
        handlers[ev].push(cb);
        return socket;
      },
      emit: function (ev, data) {
        if (_room && _connected) {
          _room.send(ev, data);
        } else {
          pending.push({ ev: ev, data: data });
        }
      },
      disconnect: function () {
        if (_room) { _room.leave(true); _room = null; }
        _connected = false;
      }
    };

    function fire(ev, arg) {
      var cbs = handlers[ev] || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](arg); } catch (e) { console.error('[colyseus-adapter]', e); }
      }
    }

    function fireMgr(ev, arg) {
      var cbs = mgr[ev] || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](arg); } catch (e) { console.error('[colyseus-adapter]', e); }
      }
    }

    function attach(room) {
      _room = room;
      _roomId = room.roomId;
      _connected = true;
      socket.id = room.sessionId;

      room.onMessage('*', function (type, msg) { fire(type, msg); });

      room.onLeave(function (code) {
        _connected = false;
        fire('disconnect', 'transport close');
        if (code !== 1000 && !isGame) {
          setTimeout(reconnect, 1500);
        }
      });

      room.onError(function (code, msg) {
        console.error('[colyseus-adapter] room error', code, msg);
      });

      var q = pending.splice(0);
      for (var i = 0; i < q.length; i++) { _room.send(q[i].ev, q[i].data); }

      fire('connect');
    }

    function reconnect() {
      if (!_roomId) return;
      var client = new Colyseus.Client(serverURL);
      client.joinById(_roomId)
        .then(function (room) {
          _attempts++;
          attach(room);
          fireMgr('reconnect', _attempts);
        })
        .catch(function () { setTimeout(reconnect, 3000); });
    }

    whenReady(function () {
      var client = new Colyseus.Client(serverURL);
      var promise;
      if (isGame && roomIdFromURL) {
        promise = client.joinById(roomIdFromURL);
      } else if (isGame) {
        promise = client.create('puz_room');
      } else {
        promise = client.joinOrCreate('puz_lobby');
      }
      promise.then(attach).catch(function (e) {
        console.error('[colyseus-adapter] connect failed', e);
        fire('connect_error', e);
      });
    });

    return socket;
  };
})();
