import React from 'react';
import { View, Text, Image, StyleSheet, ScrollView } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { ABOUT_DESCRIPTION, APP_LOGO, APP_NAME } from './constants/appConfig';

const AboutUs = ({ navigation }) => { 
  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <MaterialIcons name="arrow-back" size={28} onPress={() => navigation.goBack()} style={styles.backIcon} />
          <Image source={APP_LOGO} style={styles.logo} />
        </View>
        <Text style={styles.title} >Sariflaha {APP_NAME}</Text>
      </View>
      <Text style={styles.text}>{ABOUT_DESCRIPTION}</Text>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff', 
  },
  header: {
    marginBottom: 20,
    marginTop:20
  },
  headerContent: {
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    marginBottom: 20,
    marginTop:20
  },
  backIcon: {
    marginBottom:20,
    marginTop:20,
  },
  logo: {
    width: 96,
    height: 96,
    resizeMode: 'contain',
    alignItems:'center',
    marginBottom:20
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    color:'#347dce'
  },
  text: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'justify',
  },
 
});

export default AboutUs;
