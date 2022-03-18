const AWS = require("aws-sdk");
const uuid = require("uuid").v4;

const {
  COLLECTION_ID,
  FACES_TABLENAME,
  MIN_CONFIDENCE,
  OBJECTS_OF_INTEREST_LABELS,
  REGION,
} = process.env;

const rekognition = new AWS.Rekognition({ region: REGION });
const dynamo = new AWS.DynamoDB({ region: REGION });

const respond = (statusCode, response) => ({
  statusCode,
  body: JSON.stringify(response),
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  },
});

exports.indexHandler = async (event) => {
  const ExternalImageId = uuid();
  const body = JSON.parse(event.body);

  const indexFace = () =>
    rekognition
      .indexFaces({
        CollectionId: COLLECTION_ID,
        ExternalImageId,
        Image: { Bytes: Buffer.from(body.image, "base64") },
      })
      .promise();

  const persistMetadata = () =>
    dynamo
      .putItem({
        Item: {
          CollectionId: { S: COLLECTION_ID },
          ExternalImageId: { S: ExternalImageId },
          FullName: { S: body.fullName },
        },
        TableName: FACES_TABLENAME,
      })
      .promise();

  try {
    await indexFace();
    await persistMetadata();
    return respond(200, { ExternalImageId });
  } catch (e) {
    console.log(e);
    return respond(500, { error: e });
  }
};

const fetchFaces = async (imageBytes) => {
  /*
    Detect Faces
    Uses Rekognition's DetectFaces functionality
  */

  const facesTest = {
    TestName: "Face Detection",
  };

  const detectFaces = () =>
    rekognition.detectFaces({ Image: { Bytes: imageBytes } }).promise();

  try {
    const faces = await detectFaces();
    const nFaces = faces.FaceDetails.length;
    facesTest.Success = nFaces === 1;
    facesTest.Details = nFaces;
  } catch (e) {
    console.log(e);
    facesTest.Success = false;
    facesTest.Details = "Server error";
  }
  return facesTest;
};

const fetchLabels = async (imageBytes) => {
  /*
    Detect Objects Of Interest and number of Persons
    Uses Rekognition's DetectLabels functionality
  */

  const objectsOfInterestLabels = OBJECTS_OF_INTEREST_LABELS.trim().split(",");
  const objectsOfInterestTest = { TestName: "Objects of Interest" };
  const peopleTest = { TestName: "Person Detection" };
  const detectLabels = () =>
    rekognition
      .detectLabels({
        Image: { Bytes: imageBytes },
        MinConfidence: MIN_CONFIDENCE,
      })
      .promise();

  try {
    const labels = await detectLabels();

    const people = labels.Labels.find((x) => x.Name === "Person");
    const nPeople = people ? people.Instances.length : 0;
    peopleTest.Success = nPeople === 1;
    peopleTest.Details = nPeople;

    const objectsOfInterest = labels.Labels.filter((x) =>
      objectsOfInterestLabels.includes(x.Name)
    );
    objectsOfInterestTest.Success = objectsOfInterest.length === 0;
    objectsOfInterestTest.Details = objectsOfInterestTest.Success
      ? "0"
      : objectsOfInterest
          .map((x) => x.Name)
          .sort()
          .join(", ");
  } catch (e) {
    console.log(e);
    objectsOfInterestTest.Success = false;
    objectsOfInterestTest.Details = "Server error";
    peopleTest.Success = false;
    peopleTest.Details = "Server error";
  }
  return [objectsOfInterestTest, peopleTest];
};

const searchForIndexedFaces = async (imageBytes) => {
  const faceMatchTest = {
    TestName: "Person Recognition",
    Success: false,
    Details: "0",
  };

  const searchFace = () =>
    rekognition
      .searchFacesByImage({
        CollectionId: COLLECTION_ID,
        FaceMatchThreshold: MIN_CONFIDENCE,
        MaxFaces: 1,
        Image: { Bytes: imageBytes },
      })
      .promise();

  const getFaceByExternalImageId = (id) =>
    dynamo
      .getItem({
        TableName: FACES_TABLENAME,
        Key: { ExternalImageId: { S: id } },
      })
      .promise();

  try {
    const faces = await searchFace();
    const faceDetails = await getFaceByExternalImageId(
      faces.FaceMatches[0].Face.ExternalImageId
    );

    if (faceDetails.Item) {
      faceMatchTest.Success = true;
      faceMatchTest.Details = faceDetails.Item.FullName.S;
    }
  } catch (e) {
    // When 0 faces are recognized, rekognition.searchFacesByImage throws an error
    console.log(e);
  }
  return faceMatchTest;
};

const checkIfWearingMask = async (imageBytes) => {
  const responseText = {
    TestName: "Wearing Mask?",
    Success: false,
    Details: "0",
  };

  const detectPPE = () =>
    rekognition
    .detectProtectiveEquipment({
      Image: { Bytes: imageBytes },
      SummarizationAttributes: {
          RequiredEquipmentTypes: ["FACE_COVER"],
          MinConfidence: MIN_CONFIDENCE
      }
  })
  .promise();

  try {
    const detectPPEResults = await detectPPE();
    let bodyParts = detectPPEResults.Persons[0].BodyParts
    let isEquipmentDetected = false;
    let isEquipmentWornProperly = false;
    if (bodyParts[0].EquipmentDetections.length > 0) {
      isEquipmentDetected = true;
      if (bodyParts[0].EquipmentDetections[0]?.CoversBodyPart?.Value) {
        isEquipmentWornProperly = true;
    }
    }
    responseText.Success = isEquipmentDetected && isEquipmentWornProperly
    if(!isEquipmentDetected){
      responseText.Details = "Missing Mask"
  }
  if(isEquipmentDetected && !isEquipmentWornProperly){
      responseText.Details = "Mask does not Cover your Nose"
  }
    
  } catch (e) {
    console.log(e);
  }
  return responseText;
};

exports.processHandler = async (event) => {
  const body = JSON.parse(event.body);
  const imageBytes = Buffer.from(body.image, "base64");

  const result = await Promise.all([
    fetchLabels(imageBytes),
    searchForIndexedFaces(imageBytes),
    fetchFaces(imageBytes),
    checkIfWearingMask(imageBytes)
  ]);

  return respond(200, result.flat());
};
