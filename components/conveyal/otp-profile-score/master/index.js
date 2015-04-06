var clone;
try {
  clone = require('clone');
} catch (e) {
  clone = require('component-clone');
}

var CO2_PER_GALLON = 8.887; // Kilograms of CO2 burned per gallon of gasoline
var CYCLING_MET = 8; // Find MET scores here: http://appliedresearch.cancer.gov/atus-met/met.php
var METERS_TO_MILES = 0.000621371;
var SECONDS_TO_HOURS = 1 / 60 / 60;
var WALKING_MET = 3.8;

var CO2_PER_TRANSIT_TRIP = 239000000 / 200000000; // CO2 per passenger trip. Kilograms of CO2 / Rides. http://www.wmata.com/Images/Mrel/MF_Uploads/sustainability-web-2014-04-22.pdf

var DEFAULT_TIME_FACTORS = {
  bikeParking: 1,
  calories: -0.01,
  carParking: 5,
  co2: 0.5,
  cost: 5,
  transfer: 5
};

var DEFAULT_RATES = {
  bikeSpeed: 4.1, // in m/s
  carParkingCost: 10,
  co2PerTransitTrip: CO2_PER_TRANSIT_TRIP,
  mileageRate: 0.56, // IRS reimbursement rate per mile http://www.irs.gov/2014-Standard-Mileage-Rates-for-Business,-Medical-and-Moving-Announced
  mpg: 21.4,
  walkSpeed: 1.4, // in m/s
  weight: 75 // in kilograms
};

module.exports = ProfileScore;

/**
 * Process & score an OTP Profile response. Tally statistics, score options.
 *
 * @param {Object} opts Options object.
 * @param {Object=} opts.factors Factors to override the defaults.
 * @param {Object=} opts.rates Rates to to override the defaults.
 * @example
 * var ProfileScore = require('otp-profile-score');
 * var scorer = new ProfileScore({ factors: {}, rates: {} });
 */

function ProfileScore(opts) {
  opts = opts || {};

  this.factors = merge(DEFAULT_TIME_FACTORS, opts.factors || {});
  this.rates = merge(DEFAULT_RATES, opts.rates || {});
}

/**
 * Process an individual option, only uses the first access and egress modes given.
 *
 * @param {Object} option Option returned from OTP's profiler.
 * @returns {Object} processedOption Annotated and scored.
 * @example
 * getProfileFromOTP(query, function(err, profile) {
 *   var scoredOption = scorer.processOption(profile[0]);
 * });
 */

ProfileScore.prototype.processOption = function(o) {
  // Tally the data
  o = this.tally(o);

  // Score the option
  o.score = this.score(o);

  return o;
};

/**
 * Process an array of options that were generated by [OpenTripPlanner](http://www.opentripplanner.org)'s Profiler.
 *
 * @param {Array} options
 * @returns {Array} processedOptions Options that are split up by access mode and annotated with a score.
 * @example
 * getProfileFromOTP(query, function(err, profile) {
 *   var allScoredResults = scorer.processOptions(profile);
 * });
 */

ProfileScore.prototype.processOptions = function(options) {
  var id = 0;
  var processed = [];
  var self = this;

  options.forEach(function(o) {
    if (o.access) {
      o.access.forEach(function(a, accessIndex) {
        if (o.egress && o.egress.length > 0) {
          o.egress.forEach(function(e, egressIndex) {
            var opt = clone(o);
            opt.access = [clone(a)];
            opt.egress = [clone(e)];
            processed.push(self.processOption(opt));
          });
        } else {
          var opt = clone(o);
          opt.access = [clone(a)];
          processed.push(self.processOption(opt));
        }
      });
    }
  });

  processed.sort(function(a, b) {
    return a.score - b.score;
  });

  return processed;
};

/**
 * Get the weighted score of an option based on the factors, weights, and tallied totals for that option.
 *
 * @param {Object} option
 * @returns {Number} score
 */

ProfileScore.prototype.score = function(o) {
  var factors = this.factors;
  var score = o.time / 60;
  var totalCalories = 0;

  o.modes.forEach(function(mode) {
    switch (mode) {
      case 'car':
        // Add time for parking
        score += applyFactor(1, factors.carParking);

        // Add time for CO2 emissions
        score += applyFactor(o.emissions, factors.co2);
        break;
      case 'bicycle':
      case 'bicycle_rent':
        // Add time for locking your bike
        score += applyFactor(1, factors.bikeParking);
        totalCalories += o.bikeCalories;
        break;
      case 'walk':
        totalCalories += o.walkCalories;
        break;
    }
  });

  // Add time for each transfer
  score += applyFactor(o.transfers, this.factors.transfer);

  // Add time for each dollar spent
  score += applyFactor(o.cost, this.factors.cost);

  // Add/subtract time for calories
  score += applyFactor(totalCalories, this.factors.calories);

  return score;
};

/**
 * Tally values. Add up total calories, cost, transfers, distances, and times.
 *
 * @param {Object} option
 * @returns {Object} talliedOption
 */

ProfileScore.prototype.tally = function(o) {
  // Defaults
  o.bikeCalories = 0;
  o.calories = 0;
  o.cost = 0;
  o.emissions = 0;
  o.modes = [];
  o.time = 0;
  o.timeInTransit = 0;
  o.transfers = 0;
  o.transitCost = 0;
  o.walkCalories = 0;

  // Bike/Drive/Walk distances
  o.bikeDistance = 0;
  o.driveDistance = 0;
  o.walkDistance = 0;

  // Tally access
  if (o.access && o.access.length > 0) {
    var access = o.access[0];
    var accessMode = access.mode.toLowerCase();

    addStreetEdges(o, accessMode, access.streetEdges);

    o.time += access.time;
  }

  // Tally egress
  if (o.egress && o.egress.length > 0) {
    var egress = o.egress[0];
    var egressMode = egress.mode.toLowerCase();

    addStreetEdges(o, egressMode, egress.streetEdges);

    o.time += egress.time;
  }

  // Tally transit
  if (o.transit && o.transit.length > 0) {
    o.transfers = o.transit.length - 1;
    o.transitCost = 0;
    o.trips = Infinity;

    var self = this;
    o.transit.forEach(function(segment) {
      o.modes.push(segment.mode.toLowerCase());

      var trips = segment.segmentPatterns ? segment.segmentPatterns[0].nTrips : 0;
      if (trips < o.trips) o.trips = trips;

      // Total & add the time in transit
      var timeInTransit = (segment.waitStats.avg + segment.rideStats.avg);
      o.timeInTransit += timeInTransit;

      // Add walk time, wait time, & ride time
      o.time += segment.walkTime + timeInTransit;

      // Increment the total walk distance
      o.walkDistance += segment.walkDistance;

      // Add CO2 per transit leg
      o.emissions += self.rates.co2PerTransitTrip;
    });

    if (o.fares) {
      o.fares.forEach(function(fare) {
        if (fare && fare.peak) o.transitCost += fare.peak;
      });
    }

    o.cost += o.transitCost;
  }

  // Set the walking calories burned
  if (o.modes.indexOf('walk') !== -1) {
    o.walkCalories = caloriesBurned(WALKING_MET, this.rates.weight, (o.walkDistance / this.rates.walkSpeed) *
      SECONDS_TO_HOURS);
  }

  // Set the biking calories burned
  if (o.modes.indexOf('bicycle') !== -1 || o.modes.indexOf('bicycle_rent') !== -1) {
    o.bikeCalories = caloriesBurned(CYCLING_MET, this.rates.weight, (o.bikeDistance / this.rates.bikeSpeed) *
      SECONDS_TO_HOURS);
  }

  // Set the parking costs
  if (o.modes.indexOf('car') !== -1) {
    o.carCost = this.rates.mileageRate * (o.driveDistance * METERS_TO_MILES) + this.rates.carParkingCost;
    o.cost += o.carCost;
    o.emissions = o.driveDistance / this.rates.mpg * CO2_PER_GALLON;
  }

  // unique modes only
  o.modes = o.modes.reduce(function(modes, mode) {
    return modes.indexOf(mode) === -1 ? modes.concat(mode) : modes;
  }, [])

  // Total calories
  o.calories = o.bikeCalories + o.walkCalories;

  return o;
};

function addStreetEdges(o, mode, streetEdges) {
  if (!streetEdges) return;
  o.modes.push(mode);

  switch (mode) {
    case 'car':
      o.driveDistance += streetEdgeDistanceForMode(streetEdges, 'car');
      break;
    case 'bicycle':
      o.bikeDistance += streetEdgeDistanceForMode(streetEdges, 'bicycle');
      break;
    case 'bicycle_rent':
      o.modes.push('walk');
      o.bikeDistance += streetEdgeDistanceForMode(streetEdges, 'bicycle');
      o.walkDistance += streetEdgeDistanceForMode(streetEdges, 'walk');
      break;
    case 'walk':
      o.walkDistance += streetEdgeDistanceForMode(streetEdges, 'walk');
      break;
  }
}

function streetEdgeDistanceForMode(streetEdges, mode) {
  var currentMode = 'walk';
  return streetEdges.reduce(function(distance, step) {
    if (step.mode) {
      currentMode = step.mode.toLowerCase();
    }
    if (currentMode === mode) {
      distance += step.distance;
    }
    return distance;
  }, 0);
}

function caloriesBurned(met, kg, hours) {
  return met * kg * hours;
}

function applyFactor(v, f) {
  if (typeof f === 'function') {
    return f(v);
  } else {
    return f * v;
  }
}

function merge(a, b) {
  for (var k in b) a[k] = b[k];
  return a;
}