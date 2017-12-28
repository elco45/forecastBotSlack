"use strict";

require("dotenv").config({ silent: true });

var moment = require("moment");

var forecast = require("./lib/forecast");
var peopleFilter = require("./lib/peoplefilter");
var activity = require("./lib/activity");
var personName = require("./lib/personname");
var personTimeOff = require("./lib/persontimeoff");

var Slack = require("slack-node");
var merge = require("lodash.merge");

var relations = require("../relations");

var options = {
  startDate: moment(),
  endDate: moment().add(2, "months")  // how far to look ahead for assignments (e.g. used to calculate when back from time-off)
};

// skip if weekend
if (process.env.SKIP_IF_WEEKEND && (moment().day() === 6 || moment().day() === 0)) {
  console.log("It's weekend, skipping...");
  process.exit(); // eslint-disable-line no-process-exit
}

var createSlackInstance = function(relation) {
  var slack = new Slack();
  slack.setWebhook(process.env.SLACK_WEBHOOK);
  var slackMessenger = {};

  slackMessenger.send = function(msg) {
      var slackMsg = {
        "channel": "#" + relation.slackChannel,
        "icon_emoji": process.env.SLACK_ICON_URL,
        "username": process.env.SLACK_USERNAME
      };

      msg = merge(slackMsg, msg);

      slack.webhook(msg, function(err, response) {  // eslint-disable-line no-unused-vars
        if (err) throw Error(err);
      });
  };

  return slackMessenger;
};

var messageByDate = function(endDate, p, people) {
  if (endDate !== "today") {
    return `${personName(p, people)} is off and will be back ${endDate}.`;
  } else {
    return `${personName(p, people)} will be temporarily off today.`;
  }
};

var createTimeOffMessageByChannel = function(people, assignments, relation) {
  let msg = [];
  people.forEach(p => {
    // get person activity for current day
    let personActivityToday = activity.today(p, assignments);

    var personActivityInProject = personActivityToday.filter((x) => x.project_id === parseInt(relation.forecastProjectId) && x.person_id !== null);
    var personActivityTimeOff = personActivityToday.filter((x) => x.project_id === parseInt(process.env.PROJECT_ID_TIME_OFF) && x.person_id !== null);

    if (personActivityInProject.length > 0 && personActivityTimeOff.length > 0) {
      let personAllActivities = activity.get(p, assignments);
      let endDate = personTimeOff(personAllActivities);
      msg.push(messageByDate(endDate, p, people));
    }
  });

  return msg;
};

var createAllTimeOffMessage = function(people, assignments) {
  let msg = [];
  people.forEach(p => {
    let personActivityToday = activity.today(p, assignments);

    var personActivityTimeOff = personActivityToday.filter((x) => x.project_id === parseInt(process.env.PROJECT_ID_TIME_OFF) && x.person_id !== null);

    if (personActivityTimeOff.length > 0) {
      let personAllActivities = activity.get(p, assignments);
      let endDate = personTimeOff(personAllActivities);
      msg.push(messageByDate(endDate, p, people));
    }
  });

  return msg;
};

Promise.all([
  forecast.people(),
  forecast.projects(),
  forecast.clients(),
  forecast.assignments(options)
]).then(data => {


  relations.forEach((relation) => {
    var slack = createSlackInstance(relation);

    // send DM to script admin if failed to retrieve something
    if (data.some(d => !d)) {
      if (process.env.SLACK_FORECAST_ADMIN) {
        slack.send({
          channel: "@" + process.env.SLACK_FORECAST_ADMIN,
          text: "Just wanted to let you know I could not retrieve data from Forecast. Most likely the FORECAST_AUTH_TOKEN has expired and you need to set a new one."
        });
      }
      return;
    }

    let people = data[0];
    let assignments = data[3];

    people = peopleFilter
      // exclude persons
      .exclude(people, process.env.PEOPLE_EXCLUDE_FILTER)
      // noticed weird case with trailing space, this fixes it
      .map(p => {
        p.first_name = p.first_name.trim();
        p.last_name = p.last_name.trim();

        return p;
      });

    // sort persons alphabetically
    people.sort((a, b) => a.first_name.localeCompare(b.first_name));

    let msg = [];

    if (!relation.getAllTimeOff) {
      msg = createTimeOffMessageByChannel(people, assignments, relation);
    } else {
      msg = createAllTimeOffMessage(people, assignments);
    }

    if (msg.length > 0) {
      // send as Slack msg
      slack.send({
        attachments: [
          {
            "fallback": `${options.startDate.format("dddd YYYY-MM-DD")} according to Forecast...`,
            "pretext": `${options.startDate.format("dddd YYYY-MM-DD")} :sunrise: according to <${process.env.FORECAST_TEAM_URL}|Forecast>...`,
            "color": "good",
            "mrkdwn_in": ["pretext", "text", "fields"],
            "fields": [
                {
                  "value": msg.join("\n"),
                  "short": false
                }
            ]
          }
        ]
      });
    }
  });

}).catch(error => console.error(error.stack || error));
